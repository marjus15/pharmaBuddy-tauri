import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CUSTOMER_IDLE_MS,
  MANUAL_ENTRY_BARCODE,
  MANUAL_NAME_NOT_FOUND_MESSAGE,
  RECOMMENDATION_MORE_LABEL,
  SIDE_EFFECT_VISIBLE_LIMIT,
  SIDE_EFFECTS_FALLBACK,
  SIDE_EFFECTS_TRUST_LINE,
  barcodeForManualName,
  basketCountLabel,
  cardMetaLine,
  chooseExpandedId,
  dosageFormLabel,
  latestDrugId,
  sideEffectBullets,
  sideEffectCountLabel,
  sideEffectsMoreLabel,
  splitRecommendationSentences,
  suggestionRuleFor,
  trimAtWordBoundary,
  visibleRecommendation,
  visibleSideEffects,
} from "../src/widget-logic.mjs";

const ASPIRIN_PUBLIC_EXCERPT =
  "Περίληψη του προφίλ ασφαλείας Οι καταγραφόμενες ανεπιθύμητες ενέργειες βασίζονται σε αυθόρμητες αναφορές ανεπιθύμητων ενεργειών μετά την κυκλοφορία του φαρμάκου που αφορούν σε όλες τις μορφές/περιε...";

const ASPIRIN_WITH_LIST =
  "Περίληψη του προφίλ ασφαλείας Οι συχνότερα αναφερόμενες ανεπιθύμητες ενέργειες είναι δυσπεψία, ναυτία, έμετος, επιγαστραλγία και γαστρεντερική αιμορραγία. Κατάλογος ανεπιθύμητων ενεργειών Διαταραχές του γαστρεντερικού συστήματος Συχνές: δυσπεψία, ναυτία, έμετος. Σπάνιες: έλκος στομάχου, γαστρεντερική αιμορραγία.";

const AUGMENTIN_EXCERPT =
  "Περίληψη του προφίλ ασφάλειας. Οι συχνότερα αναφερόμενες ανεπιθύμητες ενέργειες είναι διάρροια, ναυτία, έμετος και δερματικό εξάνθημα. Οι ανεπιθύμητες ενέργειες ταξινομούνται κατά συχνότητα ως εξής: πολύ συχνές (≥1/10), συχνές (≥1/100 έως <1/10), όχι συχνές (≥1/1.000 έως <1/100), σπάνιες (≥1/10.000 έως <1/1.000), πολύ σπάνιες (<1/10.000). Λοιμώξεις και παρασιτώσεις Συχνές: καντιντίαση του δέρματος και των βλεννογόνων. Διαταραχές του ανοσοποιητικού συστήματος Σπάνιες: αναφυλαξία, αγγειοοίδημα. Διαταραχές του νευρικού συστήματος Όχι συχνές: κεφαλαλγία, ζάλη. Διαταραχές του γαστρεντερικού συστήματος Πολύ συχνές: διάρροια. Συχνές: ναυτία, έμετος, δυσπεψία, κοιλιακό άλγος. Διαταραχές του ήπατος Όχι συχνές: αύξηση ηπατικών ενζύμων. Σπάνιες: ηπατίτιδα. Διαταραχές του δέρματος Συχνές: κνησμός, κνίδωση.";

test("stored comma list becomes short bullets, common percents first", () => {
  const bullets = sideEffectBullets(
    "Ρινοφαρυγγίτιδα (14%), κεφαλαλγία (13,6%) και αναιμία.",
  );
  assert.deepEqual(bullets, ["Ρινοφαρυγγίτιδα", "Κεφαλαλγία", "Αναιμία"]);
  for (const bullet of bullets) {
    assert.equal(bullet.endsWith("."), false);
    assert.ok(bullet.split(/\s+/).length <= 5);
  }
});

test("a single stored sentence stays one short bullet", () => {
  assert.deepEqual(sideEffectBullets("Ήπια γαστρεντερική δυσφορία σε μικρό ποσοστό ασθενών."), [
    "Ήπια γαστρεντερική δυσφορία",
  ]);
});

test("rare prose drops the overdose sentence and splits alternatives", () => {
  assert.deepEqual(
    sideEffectBullets(
      "Σπάνια δερματικό εξάνθημα ή ερυθρότητα. Σε υπερβολική δόση υπάρχει κίνδυνος ηπατικής βλάβης.",
    ),
    ["Δερματικό εξάνθημα", "Ερυθρότητα"],
  );
});

test("long stored excerpt keeps common effects first and serious ones ahead of milder rare items", () => {
  const bullets = sideEffectBullets(AUGMENTIN_EXCERPT);
  assert.ok(bullets.length > SIDE_EFFECT_VISIBLE_LIMIT);
  assert.deepEqual(bullets.slice(0, 4), ["Διάρροια", "Ναυτία", "Έμετος", "Δερματικό εξάνθημα"]);
  const anaphylaxis = bullets.indexOf("Αναφυλαξία");
  const headache = bullets.indexOf("Κεφαλαλγία");
  assert.ok(anaphylaxis > 4, "serious effects stay behind the common five");
  assert.ok(headache > anaphylaxis, "serious rare effects lead milder uncommon ones");
  assert.equal(bullets.includes("Αναφυλαξία"), true);
  assert.equal(bullets.some((bullet) => /≥|συχνές\b|προφίλ ασφάλειας/i.test(bullet)), false);
  for (const bullet of bullets) assert.equal(bullet.endsWith("."), false);
});

test("more than five effects expose a collapsed row", () => {
  const view = visibleSideEffects(AUGMENTIN_EXCERPT, false);
  assert.equal(view.bullets.length, 5);
  assert.ok(view.hiddenCount >= 1);
  assert.equal(view.moreLabel, `+ ακόμη ${view.hiddenCount}`);
  assert.equal(sideEffectsMoreLabel(3), "+ ακόμη 3");
  const open = visibleSideEffects(AUGMENTIN_EXCERPT, true);
  assert.equal(open.hiddenCount, 0);
  assert.equal(open.moreLabel, "");
  assert.ok(open.bullets.length > 5);
});

test("few effects have no more-row", () => {
  const view = visibleSideEffects("Ήπια ναυτία, κεφαλαλγία και ζάλη.", false);
  assert.deepEqual(view.bullets, ["Ήπια ναυτία", "Κεφαλαλγία", "Ζάλη"]);
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.moreLabel, "");
});

test("aspirin public excerpt does not turn the safety-profile heading into a bullet", () => {
  for (const excerpt of [
    ASPIRIN_PUBLIC_EXCERPT,
    "Περίληψη του προφίλ ασφαλείας Οι",
    "Περίληψη του προφίλ ασφάλειας Οι",
  ]) {
    const bullets = sideEffectBullets(excerpt);
    assert.deepEqual(bullets, []);
    assert.equal(
      bullets.some((bullet) => /προφίλ|περίληψη|κατάλογος/i.test(bullet)),
      false,
    );
  }
  assert.equal(visibleSideEffects(ASPIRIN_PUBLIC_EXCERPT, false).bullets.length, 0);
  assert.equal(SIDE_EFFECTS_FALLBACK, "Συγκεκριμένες παρενέργειες δεν είναι διαθέσιμες.");
});

test("an aspirin-like list still yields real side effects and drops headings", () => {
  const bullets = sideEffectBullets(ASPIRIN_WITH_LIST);
  assert.deepEqual(bullets.slice(0, 5), [
    "Δυσπεψία",
    "Ναυτία",
    "Έμετος",
    "Επιγαστραλγία",
    "Γαστρεντερική αιμορραγία",
  ]);
  assert.ok(bullets.length <= 20);
  assert.equal(
    bullets.some((bullet) =>
      /προφίλ ασφαλείας|προφίλ ασφάλειας|περίληψη|κατάλογος|συχνές|σπάνιες/i.test(bullet),
    ),
    false,
  );
  assert.equal(visibleSideEffects(ASPIRIN_WITH_LIST, false).bullets.length, 5);
});

test("headings, frequency labels, and table fragments are not bullets", () => {
  assert.deepEqual(sideEffectBullets("Κατάλογος ανεπιθύμητων ενεργειών"), []);
  assert.deepEqual(sideEffectBullets("Περίληψη του προφίλ ασφαλείας"), []);
  assert.deepEqual(sideEffectBullets("Συχνές"), []);
  assert.deepEqual(sideEffectBullets("Σπάνιες"), []);
  assert.deepEqual(sideEffectBullets("Πολύ συχνές"), []);
  assert.deepEqual(
    sideEffectBullets(
      "Κατηγορία οργανικού συστήματος Συχνότητα Ανεπιθύμητη ενέργεια Συχνές Σπάνιες Πολύ σπάνιες",
    ),
    [],
  );
  assert.deepEqual(sideEffectBullets("δυσπεψία, ναυτία και έμετ..."), ["Δυσπεψία", "Ναυτία"]);
});

test("a long effect stays a short term and a cut-off word is dropped", () => {
  const source = "Παρατεταμένη αιμορραγία του ανώτερου γαστρεντερικού σωλήνα";
  const bullets = sideEffectBullets(`${source}.`);
  assert.deepEqual(bullets, ["Παρατεταμένη αιμορραγία"]);
  assert.equal(bullets.some((bullet) => /…|\.\.\./.test(bullet)), false);
  assert.deepEqual(sideEffectBullets("Καντιντίαση του δέρματος και των βλεννογόνων."), [
    "Καντιντίαση",
  ]);
  for (const bullet of bullets) {
    assert.ok(bullet.split(/\s+/).length <= 3);
  }

  const fitted = trimAtWordBoundary(source, 32);
  assert.equal(fitted.endsWith("…"), true);
  assert.ok([...fitted].length <= 32);
  const fittedBody = fitted.slice(0, -1).trim();
  assert.equal(fittedBody.includes(" "), true);
  for (const word of fittedBody.split(/\s+/)) {
    assert.equal(source.includes(word), true);
  }
  assert.equal(trimAtWordBoundary("Ναυτία", 12), "Ναυτία");
});

test("blank and unknown excerpts render nothing", () => {
  assert.deepEqual(sideEffectBullets(""), []);
  assert.deepEqual(sideEffectBullets(null), []);
  assert.deepEqual(sideEffectBullets("Δεν αναφέρεται"), []);
  assert.deepEqual(sideEffectBullets("N/A"), []);
});

test("trust line is the pharmacist wording and does not name a source", () => {
  assert.equal(SIDE_EFFECTS_TRUST_LINE, "ⓘ Τελική απόφαση: φαρμακοποιός");
  assert.equal(/γαλιν|galinos|πχπ|πηγ[ηή]/i.test(SIDE_EFFECTS_TRUST_LINE), false);
  assert.equal(/γαλιν|galinos|πχπ|πηγ[ηή]/i.test(SIDE_EFFECTS_FALLBACK), false);
});

test("pharmacist UI has no source line and uses the approved card", () => {
  const ui = ["src/main.js", "src/index.html", "src/style.css"]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.equal(/Γαληνός|galinos|ΠΧΠ|Απόσπασμα|Πηγή|πηγή/i.test(ui), false);
  const main = readFileSync("src/main.js", "utf8");
  assert.match(main, /SIDE_EFFECTS_TRUST_LINE/);
  assert.match(main, /SIDE_EFFECTS_FALLBACK/);
  assert.match(main, /suggestionRuleFor\(/);
  assert.match(main, /chooseExpandedId\(/);
  assert.match(main, /CUSTOMER_IDLE_MS/);
  assert.match(main, /\+ Νέος πελάτης/);
  assert.equal((main.match(/invoke\(\s*"get_recommendation"/g) || []).length, 1);
  assert.match(readFileSync("src/index.html", "utf8"), /<html lang="el">/);
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /font-family:\s*"Segoe UI Variable",\s*"Segoe UI",\s*"Noto Sans",\s*sans-serif/);
  assert.match(css, /\.drug-sidebar\s*\{[^}]*width:\s*360px;/s);
  assert.match(css, /\.drug-sidebar\s*\{[^}]*max-width:\s*400px;/s);
  assert.match(css, /\.drug-card\s*\{[^}]*background:\s*#0e1216;/s);
  assert.match(css, /\.drug-card\s*\{[^}]*border-left:\s*4px solid #22d3ee;/s);
  assert.match(css, /\.drug-name-btn\s*\{[^}]*font-size:\s*18px;/s);
  assert.match(css, /\.drug-name-btn\s*\{[^}]*font-weight:\s*700;/s);
  assert.match(css, /\.side-effects-label\s*\{[^}]*text-transform:\s*uppercase;/s);
  assert.match(css, /\.side-effect-chip\s*\{[^}]*background:\s*#171e24;/s);
  assert.match(css, /\.side-effects-text\.is-fallback,\s*\.side-effects-text\.is-note\s*\{[^}]*font-style:\s*italic;/s);
  assert.match(css, /\.side-effects-text\.is-fallback,\s*\.side-effects-text\.is-note\s*\{[^}]*color:\s*#7f939c;/s);
  assert.match(css, /\.drug-suggestion\s*\{[^}]*background:\s*#0f2a31;/s);
  assert.match(css, /html,\s*body\s*\{[^}]*background:\s*transparent;/s);
  assert.equal(/\.recommendation-text\s*\{[^}]*-webkit-line-clamp/.test(css), false);
  assert.equal(/\.drug-side-effects[^}]*overflow-y:\s*auto/s.test(css), false);
});

test("recommendation shows whole sentences and a more row for the rest", () => {
  const long =
    "Επειδή ξεκινάτε το Augmentin, καλό είναι να συνδυάσουμε ένα προβιοτικό. Η διάρροια είναι συχνή. Το προβιοτικό την περιορίζει. Πάρτε το με νερό.";
  assert.equal(splitRecommendationSentences(long).length, 4);
  const twoFit = visibleRecommendation(long, { fits: () => true });
  assert.equal(
    twoFit.text,
    "Επειδή ξεκινάτε το Augmentin, καλό είναι να συνδυάσουμε ένα προβιοτικό. Η διάρροια είναι συχνή.",
  );
  assert.equal(twoFit.text.endsWith("."), true);
  assert.equal(twoFit.moreLabel, RECOMMENDATION_MORE_LABEL);
  assert.equal(twoFit.moreLabel, "+ περισσότερα");

  const onlyFirstFits = visibleRecommendation(long, {
    fits: (text) => !text.includes("Η διάρροια"),
  });
  assert.equal(onlyFirstFits.text, "Επειδή ξεκινάτε το Augmentin, καλό είναι να συνδυάσουμε ένα προβιοτικό.");
  assert.equal(onlyFirstFits.more, true);

  const open = visibleRecommendation(long, { expanded: true, fits: () => false });
  assert.equal(open.text, long);
  assert.equal(open.more, false);

  const oneLong = "Μία πολύ μεγάλη πρόταση που δεν χωράει σε τρεις γραμμές αλλά δεν κόβεται.";
  const kept = visibleRecommendation(oneLong, { fits: () => false });
  assert.equal(kept.text, oneLong);
  assert.equal(kept.more, false);
});

test("the recommendation prompt asks for two short sentences", () => {
  const source = readFileSync("supabase/functions/get-ai-recommendation/index.ts", "utf8");
  assert.match(source, /Το πολύ 2 ολοκληρωμένες προτάσεις και περίπου 160 χαρακτήρες/);
  assert.match(source, /Το πολύ 2 προτάσεις, περίπου 160 χαρακτήρες συνολικά/);
  assert.match(source, /about 160 characters/);
});

test("a typed name does not keep another medicine's barcode", () => {
  const augmentin = {
    id: "a",
    barcode: "5201234567890",
    productName: "AUGMENTIN F.C.TAB",
  };
  assert.equal(
    barcodeForManualName({
      pendingBarcode: "5201234567890",
      name: "zircos",
      drugs: [augmentin],
    }),
    MANUAL_ENTRY_BARCODE,
  );
  assert.equal(
    barcodeForManualName({
      pendingBarcode: "",
      name: "zircos",
      drugs: [augmentin],
    }),
    MANUAL_ENTRY_BARCODE,
  );
  assert.equal(
    barcodeForManualName({
      pendingBarcode: MANUAL_ENTRY_BARCODE,
      name: "zircos",
      drugs: [],
    }),
    MANUAL_ENTRY_BARCODE,
  );
  assert.equal(
    barcodeForManualName({
      pendingBarcode: "5209999999999",
      name: "zircos",
      drugs: [augmentin],
    }),
    "5209999999999",
  );
});

test("the visit stack keeps scan order and marks the last card as latest", () => {
  const drugs = [
    { id: "augmentin", productName: "AUGMENTIN F.C.TAB" },
    { id: "zircos", productName: "zircos" },
  ];
  assert.equal(latestDrugId(drugs), "zircos");
  assert.equal(latestDrugId([]), null);
  const main = readFileSync("src/main.js", "utf8");
  assert.match(main, /scannedDrugs\.push\(drug\)/);
  assert.equal(/scannedDrugs\.unshift\(/.test(main), false);
  assert.match(main, /is-latest/);
});

test("a typed name with no match shows the empty sentence and does not reuse the last barcode", () => {
  assert.equal(MANUAL_NAME_NOT_FOUND_MESSAGE, "Δεν βρέθηκαν πληροφορίες για αυτό το φάρμακο");
  assert.equal(MANUAL_NAME_NOT_FOUND_MESSAGE.includes(SIDE_EFFECTS_TRUST_LINE), false);
  const main = readFileSync("src/main.js", "utf8");
  assert.equal(main.includes("pendingManualBarcode || lastAcceptedBarcode"), false);
  assert.match(main, /barcodeForManualName\(/);
  assert.match(main, /nameOnly: drug\.manualEntry === true/);
  assert.match(main, /manualEntry: true/);
  assert.match(main, /MANUAL_NAME_NOT_FOUND_MESSAGE/);
  assert.match(main, /drug\.manualEntry && drug\.sideEffectsStatus === "empty"/);
  const css = readFileSync("src/style.css", "utf8");
  assert.equal(/\.drug-item\.is-latest\.is-collapsed/.test(css), false);
  assert.match(css, /\.drug-card\s*\{[^}]*border-left:\s*4px solid #22d3ee;/s);
  assert.match(css, /\.drug-row-name\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(css, /\.drug-row-name\s*\{[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(css, /\.drug-row-tags\s*\{[^}]*flex-shrink:\s*0;/s);
  assert.match(css, /\.drug-card\.is-missing \.drug-card-ft\s*\{[^}]*display:\s*none/s);
});

test("the suggestion tag follows local ATC rules and does not call the model", () => {
  assert.equal(suggestionRuleFor({ atcCode: "J01CR02", productName: "Augmentin" })?.id, "antibiotic");
  assert.equal(suggestionRuleFor({ atcCode: "", productName: "AUGMENTIN F.C.TAB" })?.id, "antibiotic");
  assert.equal(
    suggestionRuleFor({ atcCode: "", activeIngredient: "Amoxicillin" })?.id,
    "antibiotic",
  );
  assert.equal(suggestionRuleFor({ atcCode: "C10AA05", productName: "Atorvastatin" })?.id, "statin");
  assert.equal(suggestionRuleFor({ atcCode: "", activeIngredient: "Rosuvastatin" })?.id, "statin");
  assert.equal(suggestionRuleFor({ atcCode: "", productName: "Nystatin" }), null);
  assert.equal(suggestionRuleFor({ atcCode: "A02BC01", productName: "Losec" })?.id, "gastro");
  assert.equal(
    suggestionRuleFor({ atcCode: "", productName: "Pantoprazole" })?.id,
    "gastro",
  );
  assert.equal(
    suggestionRuleFor({ atcCode: "A10BA02", activeIngredient: "Metformin" })?.id,
    "diabetes",
  );
  assert.equal(
    suggestionRuleFor({ atcCode: "N02BE01", productName: "Depon", activeIngredient: "Paracetamol" }),
    null,
  );
  assert.equal(suggestionRuleFor({ atcCode: "B01AC06", productName: "Aspirin 100mg" }), null);
  assert.equal(suggestionRuleFor({ atcCode: "N/A", productName: "Aspirin" }), null);

  const drugs = [
    { id: "aspirin", atcCode: "B01AC06", productName: "Aspirin" },
    { id: "augmentin", atcCode: "J01CR02", productName: "Augmentin" },
    { id: "statin", atcCode: "C10AA05", productName: "Atorvastatin" },
  ];
  assert.equal(
    chooseExpandedId(drugs, { addedId: "statin", previousExpandedId: "augmentin" }),
    "statin",
  );
  assert.equal(
    chooseExpandedId(drugs, { addedId: "aspirin", previousExpandedId: "augmentin" }),
    "augmentin",
  );
  assert.equal(chooseExpandedId([drugs[0]]), "aspirin");
  assert.equal(sideEffectCountLabel(2), "2 παρενέργειες");
  assert.equal(sideEffectCountLabel(1), "1 παρενέργεια");
  assert.equal(sideEffectCountLabel(0), "");
  assert.equal(basketCountLabel(3), "3 προϊόντα");
  assert.equal(CUSTOMER_IDLE_MS, 120000);
  assert.equal(
    cardMetaLine({ formLabel: "Επικαλ. δισκία", clock: "15:06", count: 1 }),
    "Επικαλ. δισκία · 15:06",
  );
  assert.equal(cardMetaLine({ index: 1, count: 3, clock: "15:06" }), "1 από 3 · 15:06");
  assert.equal(dosageFormLabel("AUGMENTIN F.C.TAB (875+125)MG"), "Επικαλ. δισκία");
});

test("the recommendation prompt may still mention one effect", () => {
  const source = readFileSync("supabase/functions/get-ai-recommendation/index.ts", "utf8");
  assert.match(source, /ΜΙΑ σχετική παρενέργεια/);
  assert.match(source, /Μην εφευρίσκεις παρενέργειες/);
});
