// CHE is said "Chay". Only the text handed to a voice changes; what the owner
// reads on screen keeps "CHE".
export function cheSpokenText(text) {
  return String(text || '').replace(/\bCHE\b/g, 'Chay').replace(/\bChe\b/g, 'Chay');
}
