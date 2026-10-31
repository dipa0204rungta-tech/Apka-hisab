// Known item names, used to correct small speech-recognition mistakes in
// item names ("जरा" -> "जीरा", "कंजू" -> "काजू"). A name is only corrected
// when exactly one known item is a single letter or vowel sign away, and the
// app always shows what was heard, so the shopkeeper can see the change.

const COMMON_ITEMS = [
  // grains, flours, pulses
  'चावल', 'बासमती', 'आटा', 'मैदा', 'सूजी', 'बेसन', 'पोहा', 'दलिया', 'साबूदाना', 'गेहूं', 'मक्का', 'बाजरा', 'ज्वार',
  'दाल', 'अरहर', 'तुअर', 'मूंग', 'उड़द', 'मसूर', 'चना', 'राजमा', 'लोबिया', 'मटर',
  // sugar, oil, dairy
  'चीनी', 'शक्कर', 'गुड़', 'मिश्री', 'नमक', 'तेल', 'घी', 'वनस्पति', 'दूध', 'दही', 'पनीर', 'मक्खन',
  // spices
  'जीरा', 'हल्दी', 'मिर्च', 'मिर्ची', 'धनिया', 'राई', 'सरसों', 'मेथी', 'सौंफ', 'अजवाइन', 'हींग', 'इलायची', 'लौंग',
  'दालचीनी', 'काली मिर्च', 'तेजपत्ता', 'जायफल', 'कलौंजी', 'अमचूर', 'गरम मसाला', 'मसाला',
  // dry fruits and snacks
  'काजू', 'बादाम', 'किशमिश', 'अखरोट', 'पिस्ता', 'मखाना', 'मूंगफली', 'नमकीन', 'बिस्कुट', 'मैगी',
  // tea, other groceries
  'चायपत्ती', 'चाय', 'कॉफी', 'साबुन', 'सर्फ', 'शैंपू', 'टूथपेस्ट', 'माचिस', 'अगरबत्ती', 'मोमबत्ती',
  // vegetables
  'आलू', 'प्याज', 'टमाटर', 'लहसुन', 'अदरक', 'नींबू', 'अंडा', 'अंडे', 'ब्रेड',
].map((w) => w.normalize('NFC'));

/** Edit distance between two strings (by Unicode code point), stopping early above `max`. */
function distance(a, b, max = 2) {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > max) return max + 1;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[y.length];
}

export function createCatalog(extraNames = []) {
  const known = new Set(COMMON_ITEMS);
  const add = (name) => {
    const base = String(name || '').split(' (')[0].trim().normalize('NFC');
    if (base) known.add(base);
  };
  extraNames.forEach(add);

  /** Correct one word, or return it unchanged. */
  const correctWord = (word) => {
    if (known.has(word) || [...word].length < 3 || !/[ऀ-ॿ]/.test(word)) return word;
    const close = [...known].filter((k) => !k.includes(' ') && distance(word, k, 1) <= 1);
    return close.length === 1 ? close[0] : word;
  };

  return {
    add,
    has: (name) => known.has(String(name).normalize('NFC')),
    /**
     * Correct an item name such as "जरा" or "कंजू (25 kg)". Returns
     * { name, heard } where heard is the original text when something changed.
     */
    correct(name) {
      const text = String(name || '').normalize('NFC');
      const cut = text.indexOf(' (');
      const base = cut === -1 ? text : text.slice(0, cut);
      const rest = cut === -1 ? '' : text.slice(cut);
      if (known.has(base)) return { name: text, heard: null };
      const fixed = base.split(' ').map(correctWord).join(' ');
      return fixed === base ? { name: text, heard: null } : { name: fixed + rest, heard: base };
    },
  };
}
