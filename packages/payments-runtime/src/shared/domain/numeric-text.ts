/** Recognize nonempty ASCII digit text without converting identifiers, losing leading zeros or accepting Unicode lookalikes. */
export function isAsciiDigits(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  for (const character of value) {
    if (character < '0' || character > '9') {
      return false;
    }
  }
  return true;
}

/** Recognize canonical unsigned decimal notation within caller-owned digit bounds. Signs, spaces, exponents and redundant leading zeros are excluded; positivity and financial limits remain domain decisions. */
export function isUnsignedDecimalText(
  value: string,
  maximumWholeDigits: number,
  maximumFractionDigits: number,
): boolean {
  const separator = value.indexOf('.');
  const whole = separator === -1 ? value : value.slice(0, separator);
  if (
    whole.length > maximumWholeDigits ||
    !isAsciiDigits(whole) ||
    (whole.length > 1 && whole.startsWith('0'))
  ) {
    return false;
  }
  if (separator === -1) {
    return true;
  }
  const fraction = value.slice(separator + 1);
  return fraction.length <= maximumFractionDigits && isAsciiDigits(fraction);
}
