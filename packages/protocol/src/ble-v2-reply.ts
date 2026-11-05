/** Reassembles one V2 vehicle-verification ciphertext from ATT value records. */
export class V2VerifyReplyReceiver {
  private fragments: Array<Uint8Array | undefined> = [];
  private failed = false;
  private completed = false;

  reset(): void {
    this.fragments = [];
    this.failed = false;
    this.completed = false;
  }

  /** First completion wins; remaining records are ignored until reset. */
  accept(notification: Uint8Array): Uint8Array | null {
    if (this.failed) throw new Error('BLE V2 reply rejected; reset required');
    if (this.completed) return null;
    // ATT values are independent: a short tail never carries into the next notification.
    for (let offset = 0; offset + 10 <= notification.length; offset += 10) {
      if (notification[offset] !== 0 || notification[offset + 1] !== 0x82
        || notification[offset + 2] !== 2) continue;
      const header = notification[offset + 3];
      const index = header & 0xf;
      const total = header >>> 4;
      if (total !== 3 || index < 1 || index > 3) {
        this.failed = true;
        throw new Error(`BLE V2 reply invalid fragment: index=${index}, total=${total}`);
      }
      const fragment = notification.subarray(offset + 4, offset + 10);
      const previous = this.fragments[index - 1];
      if (previous && previous.some((byte, i) => byte !== fragment[i])) {
        this.failed = true;
        throw new Error(`BLE V2 reply conflicting duplicate fragment: ${index}`);
      }
      this.fragments[index - 1] = fragment.slice();
      const [first, second, third] = this.fragments;
      if (first && second && third) {
        const cipher = new Uint8Array(16);
        cipher.set(first, 0);
        cipher.set(second, 6);
        cipher.set(third.subarray(0, 4), 12);
        this.completed = true;
        return cipher;
      }
    }
    return null;
  }
}
