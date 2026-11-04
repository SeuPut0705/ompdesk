/**
 * What one detection pass does with one engine. The whole policy is this table; `LocalEngineDetector` only reads
 * the facts and applies the answer.
 *
 * | up | present | registered | removed | action                                                     |
 * |----|---------|------------|---------|------------------------------------------------------------|
 * | y  | no      | no         | no      | register                                                   |
 * | -  | no      | yes        | -       | tombstone: our entry is gone, so the person deleted it     |
 * | no | yes     | yes        | -       | unregister: the engine went away; not a tombstone          |
 * | any other row                         | none                                                       |
 *
 * An entry the detector did not write (`registered` false) is the person's own, whatever its id: never touched.
 */
export type EngineAction = "register" | "unregister" | "tombstone" | "none";

export interface EngineFacts {
	/** `GET <base>/models` answered like an OpenAI model list. */
	up: boolean;
	/** models.yml has a provider with the engine's id. */
	present: boolean;
	/** The ledger says the detector wrote that entry. */
	registered: boolean;
	/** The ledger says the person deleted the automatic entry. */
	removed: boolean;
}

export function engineAction(facts: EngineFacts): EngineAction {
	if (!facts.present && facts.registered) return "tombstone";
	if (facts.up && !facts.present && !facts.registered && !facts.removed) return "register";
	if (!facts.up && facts.present && facts.registered) return "unregister";
	return "none";
}
