use serde_json::Value;

/// A dialog task may be dropped before it starts (UI shutdown or Windows thread creation failure).
/// Preserve Call's old answer-on-drop guarantee for a native runtime callback too.
pub struct DialogReply<F: FnOnce(Result<Value, String>)>(Option<F>);

impl<F: FnOnce(Result<Value, String>)> DialogReply<F> {
    pub fn new(answer: F) -> Self {
        Self(Some(answer))
    }

    pub fn finish(mut self, result: Result<Value, String>) {
        if let Some(answer) = self.0.take() {
            answer(result);
        }
    }
}

impl<F: FnOnce(Result<Value, String>)> Drop for DialogReply<F> {
    fn drop(&mut self) {
        if let Some(answer) = self.0.take() {
            answer(Err("The native dialog ended without an answer".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn a_dialog_task_dropped_before_start_answers_its_caller() {
        let answer = RefCell::new(None);
        let pending = DialogReply::new(|result| *answer.borrow_mut() = Some(result));
        drop(pending);
        assert_eq!(
            answer.into_inner(),
            Some(Err("The native dialog ended without an answer".into()))
        );
    }

    #[test]
    fn a_completed_dialog_is_not_answered_again_on_drop() {
        let answers = RefCell::new(Vec::new());
        DialogReply::new(|result| answers.borrow_mut().push(result)).finish(Ok(Value::Null));
        assert_eq!(answers.into_inner(), [Ok(Value::Null)]);
    }
}
