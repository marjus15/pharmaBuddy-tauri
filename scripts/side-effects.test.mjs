import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MANUAL_ENTRY_BARCODE,
  MANUAL_NAME_NOT_FOUND_MESSAGE,
  RECOMMENDATION_MORE_LABEL,
  SIDE_EFFECT_VISIBLE_LIMIT,
  SIDE_EFFECTS_TRUST_LINE,
  barcodeForManualName,
  latestDrugId,
  sideEffectBullets,
  sideEffectsMoreLabel,
  splitRecommendationSentences,
  visibleRecommendation,
  visibleSideEffects,
} from "../src/widget-logic.mjs";

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

test("blank and unknown excerpts render nothing", () => {
  assert.deepEqual(sideEffectBullets(""), []);
  assert.deepEqual(sideEffectBullets(null), []);
  assert.deepEqual(sideEffectBullets("Δεν αναφέρεται"), []);
  assert.deepEqual(sideEffectBullets("N/A"), []);
});

test("trust line is the pharmacist wording and does not name a source", () => {
  assert.equal(
    SIDE_EFFECTS_TRUST_LINE,
    "Βοηθητικές πληροφορίες. Η τελική απόφαση ανήκει στον φαρμακοποιό.",
  );
  assert.equal(/γαλιν|galinos|πχπ/i.test(SIDE_EFFECTS_TRUST_LINE), false);
});

test("pharmacist UI has no Galinos excerpt and uses the readable sidebar sizes", () => {
  const ui = ["src/main.js", "src/index.html", "src/style.css"]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  assert.equal(/Γαληνός|galinos\.gr|Απόσπασμα ΠΧΠ/i.test(ui), false);
  assert.match(readFileSync("src/main.js", "utf8"), /SIDE_EFFECTS_TRUST_LINE/);
  assert.match(readFileSync("src/index.html", "utf8"), /<html lang="el">/);
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /font-family:\s*"Segoe UI Variable",\s*"Segoe UI",\s*sans-serif/);
  assert.match(css, /\.drug-sidebar\s*\{[^}]*width:\s*360px;/s);
  assert.match(css, /\.drug-sidebar\s*\{[^}]*max-width:\s*400px;/s);
  assert.match(css, /\.drug-name-btn\s*\{[^}]*font-size:\s*22px;/s);
  assert.match(css, /\.drug-name-btn\s*\{[^}]*font-weight:\s*600;/s);
  assert.match(css, /\.side-effects-label\s*\{[^}]*font-size:\s*14px;/s);
  assert.match(css, /\.side-effects-label\s*\{[^}]*font-weight:\s*600;/s);
  assert.match(css, /\.side-effects-label\s*\{[^}]*text-transform:\s*none;/s);
  assert.match(css, /\.side-effects-list li\s*\{[^}]*font-size:\s*18px;/s);
  assert.match(css, /\.side-effects-list li\s*\{[^}]*line-height:\s*26px;/s);
  assert.match(css, /\.side-effects-list li\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(css, /\.side-effects-note\s*\{[^}]*font-size:\s*13px;/s);
  assert.match(css, /\.side-effects-note\s*\{[^}]*color:\s*#c9d6e4;/s);
  assert.match(css, /\.side-effects-more,[\s\S]*?height:\s*32px;/);
  assert.match(css, /\.drug-side-effects\s*\{[^}]*max-height:\s*260px;/s);
  assert.match(css, /\.drug-side-effects\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.drug-recommendation\s*\{[^}]*overflow:\s*visible;/s);
  assert.match(css, /\.recommendation-text\s*\{[^}]*font-size:\s*18px;/s);
  assert.match(css, /\.recommendation-text\s*\{[^}]*line-height:\s*26px;/s);
  assert.equal(/\.recommendation-text\s*\{[^}]*-webkit-line-clamp/.test(css), false);
  assert.equal(/\.drug-side-effects[^}]*overflow-y:\s*auto/s.test(css), false);
  assert.equal(/\.drug-recommendation[^}]*overflow-y:\s*auto/s.test(css), false);
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
  assert.match(css, /\.drug-item\.is-latest \.drug-name-btn/);
  assert.match(
    css,
    /\.drug-side-effects\.is-missing \.side-effects-note[\s\S]*display:\s*none/,
  );
});

test("the recommendation prompt may still mention one effect", () => {
  const source = readFileSync("supabase/functions/get-ai-recommendation/index.ts", "utf8");
  assert.match(source, /ΜΙΑ σχετική παρενέργεια/);
  assert.match(source, /Μην εφευρίσκεις παρενέργειες/);
});
