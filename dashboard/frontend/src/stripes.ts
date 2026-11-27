/**
 * Alternating tints that a turn keeps once given. A turn takes the opposite of the neighbour it
 * arrives beside, so turns arriving at either end of a list never flip the ones already drawn.
 */
export class Stripes {
  private tints = new Map<number, boolean>();
  private list: string | null = null;
  private held = 0;

  /** `list` names what is listed; a different one starts the tints again. */
  update(list: string, numbers: readonly number[]): void {
    if (list !== this.list) {
      this.tints.clear();
      this.list = list;
      this.held = 0;
    }
    if (numbers.length === 0) return;
    let first = numbers.findIndex((number) => this.tints.has(number));
    if (first === -1) {
      // By the turn number, so consecutive turns stripe the same whenever the list starts.
      this.tints.set(numbers[0], numbers[0] % 2 === 1);
      first = 0;
    }
    let last = first;
    for (let at = numbers.length - 1; at > first; at--) {
      if (this.tints.has(numbers[at])) {
        last = at;
        break;
      }
    }
    for (let at = first - 1; at >= 0; at--) {
      this.tints.set(numbers[at], !this.tints.get(numbers[at + 1]));
    }
    // Unbroken unless a turn came in between two already striped, or one between them went.
    if (last - first + 1 !== this.held) {
      for (let at = first + 1; at < last; at++) {
        if (!this.tints.has(numbers[at])) this.tints.set(numbers[at], !this.tints.get(numbers[at - 1]));
      }
    }
    for (let at = last + 1; at < numbers.length; at++) {
      this.tints.set(numbers[at], !this.tints.get(numbers[at - 1]));
    }
    this.held = numbers.length;
  }

  tinted(number: number): boolean {
    return this.tints.get(number) ?? false;
  }
}
