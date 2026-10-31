// Converts spoken number words (English, Hindi in Devanagari, romanised Hindi)
// into digits so the command parser only has to deal with numerals.

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

// ड़/ढ़ can be typed as one code point or as letter + nukta; NFC makes them match.
function nfcKeys(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.normalize('NFC'), v]));
}

const UNITS = nfcKeys({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,

  'शून्य': 0, 'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5,
  'छह': 6, 'छः': 6, 'छे': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'ग्यारह': 11, 'बारह': 12, 'तेरह': 13, 'चौदह': 14, 'पंद्रह': 15, 'पन्द्रह': 15,
  'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19, 'बीस': 20,
  'पच्चीस': 25, 'तीस': 30, 'पैंतीस': 35, 'चालीस': 40, 'पैंतालीस': 45,
  'पचास': 50, 'पचपन': 55, 'साठ': 60, 'पैंसठ': 65, 'सत्तर': 70, 'पचहत्तर': 75,
  'अस्सी': 80, 'पचासी': 85, 'नब्बे': 90, 'पंचानवे': 95,

  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5,
  chhah: 6, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11,
  barah: 12, baarah: 12, pandrah: 15, bees: 20, bis: 20, pachchis: 25,
  pachis: 25, tees: 30, chalis: 40, chaalis: 40, pachas: 50, pachaas: 50,
  saath: 60, sattar: 70, assi: 80, nabbe: 90,
});

const FRACTIONS = nfcKeys({
  half: 0.5, quarter: 0.25,
  'आधा': 0.5, 'आधी': 0.5, 'आधे': 0.5, aadha: 0.5, adha: 0.5, aadhi: 0.5,
  'पाव': 0.25, paav: 0.25, pav: 0.25,
  'पौन': 0.75, paun: 0.75,
  'डेढ़': 1.5, 'डेढ': 1.5, dedh: 1.5, derh: 1.5,
  'ढाई': 2.5, dhai: 2.5, dhaai: 2.5,
});

// Hindi prefixes that modify the number that follows: सवा दो = 2.25 etc.
const PREFIX_MODIFIERS = nfcKeys({
  'सवा': 0.25, sava: 0.25, sawa: 0.25,
  'साढ़े': 0.5, 'साढे': 0.5, sadhe: 0.5, saadhe: 0.5, sade: 0.5,
  'पौने': -0.25, paune: -0.25,
});

const MULTIPLIERS = nfcKeys({
  hundred: 100, thousand: 1000, lakh: 100000, lac: 100000,
  'सौ': 100, 'हज़ार': 1000, 'हजार': 1000, 'लाख': 100000,
  sau: 100, hazaar: 1000, hazar: 1000, hajar: 1000,
});

const isNumeral = (t) => /^\d+(\.\d+)?$/.test(t);
const isNumberWord = (t) => t in UNITS || t in FRACTIONS || t in MULTIPLIERS || t in PREFIX_MODIFIERS;

/** Replace Devanagari digits with ASCII digits. */
export function normaliseDigits(text) {
  return text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
}

/**
 * Parse one run of number tokens into a value. Returns null when the run
 * does not form a sensible number.
 */
function parseRun(tokens) {
  let total = 0;
  let current = null;
  let modifier = 0;
  let decimals = null; // digits collected after "point"

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (decimals !== null) {
      if (t in UNITS && UNITS[t] < 10) { decimals += String(UNITS[t]); continue; }
      if (/^\d+$/.test(t)) { decimals += t; continue; }
      return null;
    }
    if (t === 'point' || t === 'दशमलव') {
      if (current === null && total === 0) return null;
      decimals = '';
      continue;
    }
    if (t === 'and') {
      // "one and a half"
      const next = tokens[i + 1] === 'a' ? tokens[i + 2] : tokens[i + 1];
      if (next in FRACTIONS && current !== null) {
        current += FRACTIONS[next];
        i += tokens[i + 1] === 'a' ? 2 : 1;
        continue;
      }
      continue; // "one hundred and fifty"
    }
    if (t in PREFIX_MODIFIERS) { modifier += PREFIX_MODIFIERS[t]; continue; }
    if (t in FRACTIONS) {
      current = (current ?? 0) + FRACTIONS[t];
      continue;
    }
    if (t in MULTIPLIERS) {
      let base = current ?? 1;
      if (modifier) { base += modifier; modifier = 0; }
      if (MULTIPLIERS[t] === 100) {
        current = base * 100;
      } else {
        total += base * MULTIPLIERS[t];
        current = null;
      }
      continue;
    }
    const value = isNumeral(t) ? parseFloat(t) : UNITS[t];
    if (value === undefined) return null;
    const lastTwo = current === null ? null : current % 100;
    if (current !== null && Number.isInteger(current) && value < 10 && Number.isInteger(value) && lastTwo >= 20 && lastTwo % 10 === 0) {
      current += value; // "twenty five", "one hundred twenty five"
    } else if (current !== null && current >= 100 && lastTwo === 0 && value < 100) {
      current += value; // "one hundred fifty", "दो सौ पचास"
    } else if (current !== null) {
      return null; // two separate numbers in a row: "two sixty" is ambiguous
    } else {
      current = value;
    }
  }

  let value = total + (current ?? 0);
  if (modifier) {
    // "सवा" on its own means 1.25, "साढ़े तीन" means 3.5
    value = (current === null && total === 0 ? 1 : value) + modifier;
  }
  if (decimals) value = parseFloat(`${Math.trunc(value)}.${decimals}`);
  if (decimals === '') return null;
  return value;
}

/**
 * Replace runs of number words (and numerals mixed with multipliers) with a
 * single numeral token. "one and a half kilo" -> "1.5 kilo",
 * "डेढ़ सौ रुपये" -> "150 रुपये". Returns the rewritten token list.
 */
export function wordsToNumbers(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const startsRun = isNumberWord(t) || isNumeral(t);
    // "a"/"an" are only numbers in "half a kilo" style phrases, handled by the parser.
    if (!startsRun) { out.push(t); i++; continue; }

    const run = [t];
    let j = i + 1;
    while (j < tokens.length) {
      const n = tokens[j];
      if (isNumberWord(n) || n === 'point' || n === 'दशमलव') { run.push(n); j++; continue; }
      if (isNumeral(n) && (run[run.length - 1] === 'point' || run[run.length - 1] === 'दशमलव' || /^(point|दशमलव)$/.test(run[run.length - 2] || ''))) {
        run.push(n); j++; continue;
      }
      if (n === 'and' && j + 1 < tokens.length && (isNumberWord(tokens[j + 1]) || (tokens[j + 1] === 'a' && tokens[j + 2] in FRACTIONS))) {
        run.push(n); j++;
        if (tokens[j] === 'a') { run.push('a'); j++; }
        continue;
      }
      break;
    }

    // Lone numerals pass straight through; "2 two" style runs are treated as
    // separate numbers so the parser can flag them.
    if (run.length === 1 && isNumeral(t)) { out.push(t); i++; continue; }

    const value = parseRun(run);
    if (value === null) {
      // Fall back to converting each token individually.
      for (const r of run) {
        if (isNumeral(r)) out.push(r);
        else if (r in UNITS) out.push(String(UNITS[r]));
        else if (r in FRACTIONS) out.push(String(FRACTIONS[r]));
        else out.push(r);
      }
    } else {
      out.push(String(Math.round(value * 1000) / 1000));
    }
    i = j;
  }
  return out;
}
