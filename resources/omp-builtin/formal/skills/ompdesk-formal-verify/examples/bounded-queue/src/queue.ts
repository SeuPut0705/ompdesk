// Toy code for the bounded-queue example: a queue with a fixed capacity, used by one producer and one consumer.
export class BoundedQueue<T> {
	private items: T[] = [];
	constructor(readonly capacity: number) {}

	/** Adds an item; refuses (returns false) when the queue is full. */
	push(item: T): boolean {
		if (this.items.length >= this.capacity) return false;
		this.items.push(item);
		return true;
	}

	/** Removes the oldest item; returns undefined when the queue is empty. */
	shift(): T | undefined {
		if (this.items.length === 0) return undefined;
		return this.items.shift();
	}
}
