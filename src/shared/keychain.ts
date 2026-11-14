/**
 * The one reason the macOS keychain gives for refusing a read without asking (native-rust › S › The keychain on
 * macOS): the shell's `--keychain-key` one-shot reads with user interaction disabled, and a read that would show a
 * dialog answers `{"unavailable": KEYCHAIN_WOULD_ASK}`. Nothing touches the keychain again that run.
 */
export const KEYCHAIN_WOULD_ASK = "keychain-would-ask";
