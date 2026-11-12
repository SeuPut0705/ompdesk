//! The part of JavaScript's regular expressions the turn-resume classifiers use (`src/main/turn-resume.ts`,
//! `src/shared/quota-reset.ts`), run over UTF-16 units as V8 runs a pattern without the `u` flag, so each pattern
//! stays the text it was in the TypeScript and a message matches or fails to as it did there.
//!
//! Supported: literals, `.` (any unit but a line terminator), `\b`, `\w`, `\s`, `\d`, escaped punctuation, classes
//! (ranges, a leading `^`, `\s`/`\w`/`\d`/`\n` inside), groups (capturing, `(?:…)`), alternation and the greedy
//! quantifiers `? * + {m} {m,n}`, with the `i` flag (ASCII folding: every pattern here is ASCII, and JavaScript never
//! folds a non-ASCII unit to an ASCII one without `u`).

use std::sync::LazyLock;

#[derive(Debug)]
enum Node {
    Lit(u16),
    Any,
    Class(Class),
    WordBoundary,
    Cat(Vec<Node>),
    Alt(Vec<Node>),
    Group(Box<Node>, Option<usize>),
    Rep {
        node: Box<Node>,
        min: usize,
        max: Option<usize>,
    },
}

#[derive(Debug)]
struct Class {
    negated: bool,
    items: Vec<Item>,
}

#[derive(Debug)]
enum Item {
    Range(u16, u16),
    Word,
    Space,
    Digit,
}

#[derive(Debug)]
pub struct Regex {
    root: Node,
    groups: usize,
    icase: bool,
}

type Caps = Vec<Option<(usize, usize)>>;

fn is_word(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f)
}

fn is_space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}

fn swap_case(unit: u16) -> u16 {
    match unit {
        0x41..=0x5a => unit + 0x20,
        0x61..=0x7a => unit - 0x20,
        other => other,
    }
}

impl Item {
    fn contains(&self, unit: u16) -> bool {
        match self {
            Item::Range(low, high) => (*low..=*high).contains(&unit),
            Item::Word => is_word(unit),
            Item::Space => is_space(unit),
            Item::Digit => matches!(unit, 0x30..=0x39),
        }
    }
}

impl Class {
    fn matches(&self, unit: u16, icase: bool) -> bool {
        let has = |unit: u16| self.items.iter().any(|item| item.contains(unit));
        let found = has(unit) || (icase && swap_case(unit) != unit && has(swap_case(unit)));
        found != self.negated
    }
}

struct Parser<'a> {
    pattern: &'a [u16],
    at: usize,
    groups: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u16> {
        self.pattern.get(self.at).copied()
    }

    fn eat(&mut self, unit: char) -> bool {
        if self.peek() == Some(unit as u16) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    fn alternation(&mut self) -> Node {
        let mut branches = vec![self.sequence()];
        while self.eat('|') {
            branches.push(self.sequence());
        }
        if branches.len() == 1 {
            branches.remove(0)
        } else {
            Node::Alt(branches)
        }
    }

    fn sequence(&mut self) -> Node {
        let mut parts = Vec::new();
        while let Some(unit) = self.peek() {
            if unit == '|' as u16 || unit == ')' as u16 {
                break;
            }
            let atom = self.atom();
            parts.push(self.quantified(atom));
        }
        Node::Cat(parts)
    }

    fn quantified(&mut self, atom: Node) -> Node {
        let (min, max) = match self.peek().and_then(|unit| char::from_u32(u32::from(unit))) {
            Some('?') => (0, Some(1)),
            Some('*') => (0, None),
            Some('+') => (1, None),
            Some('{') => {
                let start = self.at;
                self.at += 1;
                let low = self.number();
                let high = if self.eat(',') {
                    if self.peek() == Some('}' as u16) {
                        None
                    } else {
                        Some(self.number())
                    }
                } else {
                    Some(low)
                };
                if self.peek() != Some('}' as u16) {
                    // Not a quantifier: the brace was a literal (never in these patterns).
                    self.at = start;
                    return atom;
                }
                (low, high)
            }
            _ => return atom,
        };
        self.at += 1;
        Node::Rep {
            node: Box::new(atom),
            min,
            max,
        }
    }

    fn number(&mut self) -> usize {
        let mut value = 0usize;
        while let Some(unit @ 0x30..=0x39) = self.peek() {
            value = value * 10 + usize::from(unit - 0x30);
            self.at += 1;
        }
        value
    }

    fn atom(&mut self) -> Node {
        let unit = self.peek().unwrap_or(0);
        self.at += 1;
        match char::from_u32(u32::from(unit)).unwrap_or('\0') {
            '.' => Node::Any,
            '(' => {
                let index = if self.eat('?') {
                    self.eat(':');
                    None
                } else {
                    self.groups += 1;
                    Some(self.groups)
                };
                let inner = self.alternation();
                self.eat(')');
                Node::Group(Box::new(inner), index)
            }
            '[' => Node::Class(self.class()),
            '\\' => self.escape(),
            _ => Node::Lit(unit),
        }
    }

    fn escape(&mut self) -> Node {
        let unit = self.peek().unwrap_or(0);
        self.at += 1;
        match char::from_u32(u32::from(unit)).unwrap_or('\0') {
            'b' => Node::WordBoundary,
            'w' => Node::Class(Class {
                negated: false,
                items: vec![Item::Word],
            }),
            's' => Node::Class(Class {
                negated: false,
                items: vec![Item::Space],
            }),
            'd' => Node::Class(Class {
                negated: false,
                items: vec![Item::Digit],
            }),
            'n' => Node::Lit(0x0a),
            _ => Node::Lit(unit),
        }
    }

    fn class(&mut self) -> Class {
        let negated = self.eat('^');
        let mut items = Vec::new();
        while let Some(unit) = self.peek() {
            self.at += 1;
            if unit == ']' as u16 {
                break;
            }
            let low = if unit == '\\' as u16 {
                let escaped = self.peek().unwrap_or(0);
                self.at += 1;
                match char::from_u32(u32::from(escaped)).unwrap_or('\0') {
                    's' => {
                        items.push(Item::Space);
                        continue;
                    }
                    'w' => {
                        items.push(Item::Word);
                        continue;
                    }
                    'd' => {
                        items.push(Item::Digit);
                        continue;
                    }
                    'n' => 0x0a,
                    _ => escaped,
                }
            } else {
                unit
            };
            // `a-z`, but a `-` before the closing bracket (or first) is a literal.
            if self.peek() == Some('-' as u16)
                && self
                    .pattern
                    .get(self.at + 1)
                    .is_some_and(|next| *next != ']' as u16)
            {
                self.at += 1;
                let mut high = self.peek().unwrap_or(low);
                self.at += 1;
                if high == '\\' as u16 {
                    high = self.peek().unwrap_or(high);
                    self.at += 1;
                }
                items.push(Item::Range(low, high));
            } else {
                items.push(Item::Range(low, low));
            }
        }
        Class { negated, items }
    }
}

struct Run<'a> {
    input: &'a [u16],
    icase: bool,
}

impl Run<'_> {
    fn unit_eq(&self, left: u16, right: u16) -> bool {
        left == right || (self.icase && swap_case(left) == right)
    }

    fn m(
        &self,
        node: &Node,
        pos: usize,
        caps: &mut Caps,
        k: &mut dyn FnMut(usize, &mut Caps) -> bool,
    ) -> bool {
        match node {
            Node::Lit(unit) => match self.input.get(pos) {
                Some(found) if self.unit_eq(*found, *unit) => k(pos + 1, caps),
                _ => false,
            },
            Node::Any => match self.input.get(pos) {
                Some(found) if !is_line_terminator(*found) => k(pos + 1, caps),
                _ => false,
            },
            Node::Class(class) => match self.input.get(pos) {
                Some(found) if class.matches(*found, self.icase) => k(pos + 1, caps),
                _ => false,
            },
            Node::WordBoundary => {
                let before = pos > 0 && is_word(self.input[pos - 1]);
                let after = self.input.get(pos).is_some_and(|unit| is_word(*unit));
                before != after && k(pos, caps)
            }
            Node::Cat(parts) => self.cat(parts, pos, caps, k),
            Node::Alt(branches) => branches
                .iter()
                .any(|branch| self.m(branch, pos, caps, &mut *k)),
            Node::Group(inner, index) => match index {
                None => self.m(inner, pos, caps, k),
                Some(index) => {
                    let index = *index;
                    self.m(inner, pos, caps, &mut |end, caps: &mut Caps| {
                        let old = caps[index];
                        caps[index] = Some((pos, end));
                        if k(end, caps) {
                            true
                        } else {
                            caps[index] = old;
                            false
                        }
                    })
                }
            },
            Node::Rep { node, min, max } => self.rep(node, *min, *max, 0, pos, caps, k),
        }
    }

    fn cat(
        &self,
        parts: &[Node],
        pos: usize,
        caps: &mut Caps,
        k: &mut dyn FnMut(usize, &mut Caps) -> bool,
    ) -> bool {
        match parts.split_first() {
            None => k(pos, caps),
            Some((first, rest)) => self.m(first, pos, caps, &mut |next, caps: &mut Caps| {
                self.cat(rest, next, caps, &mut *k)
            }),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn rep(
        &self,
        node: &Node,
        min: usize,
        max: Option<usize>,
        count: usize,
        pos: usize,
        caps: &mut Caps,
        k: &mut dyn FnMut(usize, &mut Caps) -> bool,
    ) -> bool {
        if max.is_none_or(|max| count < max)
            && self.m(node, pos, caps, &mut |next, caps: &mut Caps| {
                // An empty iteration past the minimum cannot go on.
                if next == pos && count >= min {
                    return false;
                }
                self.rep(node, min, max, count + 1, next, caps, &mut *k)
            })
        {
            return true;
        }
        count >= min && k(pos, caps)
    }
}

impl Regex {
    /// Parses `pattern` as the text between a JavaScript literal's slashes.
    pub fn new(pattern: &str, icase: bool) -> Regex {
        let units: Vec<u16> = pattern.encode_utf16().collect();
        let mut parser = Parser {
            pattern: &units,
            at: 0,
            groups: 0,
        };
        let root = parser.alternation();
        Regex {
            root,
            groups: parser.groups,
            icase,
        }
    }

    /// The first match (leftmost, alternatives in order, greedy) as `exec` finds it: its groups, `[0]` the whole.
    pub fn exec(&self, text: &str) -> Option<Vec<Option<String>>> {
        let input: Vec<u16> = text.encode_utf16().collect();
        let run = Run {
            input: &input,
            icase: self.icase,
        };
        for start in 0..=input.len() {
            let mut caps: Caps = vec![None; self.groups + 1];
            let mut end = None;
            if run.m(&self.root, start, &mut caps, &mut |found, _| {
                end = Some(found);
                true
            }) {
                caps[0] = Some((start, end.unwrap_or(start)));
                return Some(
                    caps.iter()
                        .map(|cap| cap.map(|(from, to)| String::from_utf16_lossy(&input[from..to])))
                        .collect(),
                );
            }
        }
        None
    }

    pub fn test(&self, text: &str) -> bool {
        self.exec(text).is_some()
    }
}

/// A pattern compiled once.
pub struct Lazy(LazyLock<Regex>);

impl Lazy {
    pub const fn new(init: fn() -> Regex) -> Lazy {
        Lazy(LazyLock::new(init))
    }

    pub fn test(&self, text: &str) -> bool {
        self.0.test(text)
    }

    pub fn exec(&self, text: &str) -> Option<Vec<Option<String>>> {
        self.0.exec(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alternation_takes_the_first_branch_that_matches_at_the_leftmost_start() {
        let re = Regex::new("a|ab", false);
        let found = re.exec("xab").expect("match");
        assert_eq!(found[0].as_deref(), Some("a"));
    }

    #[test]
    fn folds_ascii_case_only_when_asked() {
        assert!(Regex::new("fetch failed", true).test("FETCH Failed"));
        assert!(!Regex::new("fetch failed", false).test("FETCH Failed"));
        // The Kelvin sign is not a `k` without the `u` flag.
        assert!(!Regex::new("k", true).test("\u{212a}"));
    }

    #[test]
    fn optional_any_unit_and_optional_groups() {
        let re = Regex::new("network.?error|timed? out", true);
        assert!(re.test("a network-error"));
        assert!(re.test("networkerror"));
        assert!(re.test("it timed out"));
        assert!(re.test("it time out"));
        assert!(!re.test("network\n\nerror"));
        assert!(!re.test("network😀error"));
    }

    #[test]
    fn word_boundaries_and_counted_repeats() {
        let re = Regex::new(r"\b(?:500|502)\b", true);
        assert!(re.test("HTTP 502 bad"));
        assert!(!re.test("500000 tokens"));
        let near = Regex::new(r"\bcredits?\b[^\n]{0,3}\bgone\b", true);
        assert!(near.test("credit x gone"));
        assert!(!near.test("credit xxxx gone"));
    }

    #[test]
    fn captures_follow_the_branch_taken() {
        let re = Regex::new(
            r"couldn't reach ([a-z0-9.-]+)|(?:ENOTFOUND|EAI_AGAIN) ([a-z0-9.-]+)|https?:\/\/([a-z0-9.-]+)",
            true,
        );
        let found = re
            .exec("getaddrinfo ENOTFOUND api.anthropic.com")
            .expect("match");
        assert_eq!(found[2].as_deref(), Some("api.anthropic.com"));
        assert_eq!(found[1], None);
        let url = re
            .exec("failed: https://api.anthropic.com/v1/oauth")
            .expect("match");
        assert_eq!(url[3].as_deref(), Some("api.anthropic.com"));
    }

    #[test]
    fn classes_with_ranges_escapes_and_a_trailing_dash() {
        let re = Regex::new(r"rate[ _.-]?limit", true);
        assert!(re.test("Rate-Limit"));
        assert!(re.test("rate_limit"));
        assert!(re.test("rate limit"));
        let digits = Regex::new(r"\bretry-after-ms\s*[:=]\s*(\d+)\b", true);
        let found = digits.exec("x retry-after-ms=1500 y").expect("match");
        assert_eq!(found[1].as_deref(), Some("1500"));
    }

    #[test]
    fn backtracks_into_a_greedy_repeat() {
        let re = Regex::new("a+ab", false);
        assert!(re.test("aaab"));
        assert!(!re.test("aaa"));
    }
}
