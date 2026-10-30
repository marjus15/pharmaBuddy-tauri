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
  PANEL_MAX_INSET,
  basketExpandedId,
  basketSuggestionKind,
  cardMetaLine,
  chooseExpandedId,
  clampWindowToWorkArea,
  panelMaxHeight,
  collapsedSideEffectCountLabel,
  dosageFormLabel,
  latestDrugId,
  sideEffectBullets,
  sideEffectCountLabel,
  sideEffectsMoreLabel,
  splitRecommendationSentences,
  suggestionRuleFor,
  trimAtWordBoundary,
  clampRecommendation,
  visibleRecommendation,
  visibleSideEffects,
  RECOMMENDATION_MAX_CHARS,
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
  assert.match(main, /basketSuggestionKind\(/);
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

test("recommendation stays within two lines and ends on a whole word", () => {
  const style = "Μαζί με Panadol, μια αναβράζουσα βιταμίνη C για το κρυολόγημα.";
  assert.ok([...style].length <= RECOMMENDATION_MAX_CHARS);
  assert.equal(clampRecommendation(style), style);
  assert.equal(visibleRecommendation(style, { fits: () => true }).text, style);
  assert.equal(visibleRecommendation(style, { fits: () => true }).more, false);

  const long =
    "Με το Panadol Actifast καλό είναι να συνδυάσουμε μια αναβράζουσα βιταμίνη C. Θα ενισχύσει το ανοσοποιητικό σας για να περάσει πιο γρήγορα η ίωση.";
  assert.ok([...long].length > RECOMMENDATION_MAX_CHARS);
  const clamped = visibleRecommendation(long, { fits: () => true });
  assert.equal(clamped.text.endsWith("…"), true);
  assert.ok([...clamped.text].length <= RECOMMENDATION_MAX_CHARS);
  assert.equal(clamped.moreLabel, RECOMMENDATION_MORE_LABEL);
  const keptBody = clamped.text.slice(0, -1).trim();
  assert.equal(long.startsWith(keptBody), true);
  assert.equal(keptBody.endsWith(" "), false);
  for (const word of keptBody.split(/\s+/)) {
    assert.equal(long.includes(word), true);
  }

  const onlyOpening = visibleRecommendation(long, {
    fits: (text) => !text.includes("Θα ενισχύσει"),
  });
  assert.equal(
    onlyOpening.text,
    "Με το Panadol Actifast καλό είναι να συνδυάσουμε μια αναβράζουσα βιταμίνη C. Θα…",
  );
  assert.equal(onlyOpening.more, true);

  const open = visibleRecommendation(long, { expanded: true, fits: () => false });
  assert.equal(open.text, long);
  assert.equal(open.more, false);

  const tooWide = visibleRecommendation(style, { fits: () => false });
  assert.equal(tooWide.text, "Μαζί…");
  assert.equal(tooWide.more, true);
  assert.equal(/-webkit-line-clamp/.test(readFileSync("src/style.css", "utf8")), false);
});

test("the recommendation prompt asks for one short sentence without a health promise", () => {
  const source = readFileSync("supabase/functions/get-ai-recommendation/index.ts", "utf8");
  assert.match(source, /ΜΙΑ μόνο ολοκληρωμένη πρόταση, έως περίπου 90 χαρακτήρες/);
  assert.match(source, /ΜΙΑ πρόταση, έως περίπου 90 χαρακτήρες, χωρίς υποσχέσεις υγείας/);
  assert.match(source, /about 90 characters at most, with no health promises/);
  assert.match(source, /Μαζί με Panadol, μια αναβράζουσα βιταμίνη C για το κρυολόγημα/);
  assert.match(source, /θα ενισχύσει το ανοσοποιητικό/);
  assert.match(source, /θα περάσει πιο γρήγορα/);
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

test("the newest scan is inserted first and stays the latest card", () => {
  const drugs = [
    { id: "zircos", productName: "zircos" },
    { id: "augmentin", productName: "AUGMENTIN F.C.TAB" },
  ];
  assert.equal(latestDrugId(drugs), "zircos");
  assert.equal(latestDrugId([]), null);
  assert.equal(
    chooseExpandedId(
      [{ id: "zircos", productName: "zircos" }, { id: "depon", productName: "Depon" }],
      {},
    ),
    "zircos",
  );
  const main = readFileSync("src/main.js", "utf8");
  assert.match(main, /scannedDrugs\.unshift\(drug\)/);
  assert.equal(/scannedDrugs\.push\(drug\)/.test(main), false);
  assert.match(main, /expandedDrugId = drug\.id/);
  assert.match(main, /is-latest/);
  assert.match(main, /className = "drug-collapsed"/);
  assert.match(main, /new ResizeObserver/);
});

test("the window grows downward and stays inside the work area", () => {
  const workArea = { x: 0, y: 0, width: 1440, height: 800 };
  const nearTop = clampWindowToWorkArea({
    x: 800, y: 8, width: 648, height: 900, workArea, minHeight: 288,
  });
  assert.equal(nearTop.y, 8);
  assert.equal(nearTop.height, 792);
  assert.equal(nearTop.x, 792);

  const nearBottom = clampWindowToWorkArea({
    x: 900, y: 620, width: 648, height: 500, workArea, minHeight: 288,
  });
  assert.equal(nearBottom.y, 512);
  assert.equal(nearBottom.height, 288);
  assert.ok(nearBottom.y >= workArea.y);
  assert.ok(nearBottom.y + nearBottom.height <= workArea.y + workArea.height);

  const above = clampWindowToWorkArea({
    x: -20, y: -40, width: 250, height: 288, workArea, minHeight: 288,
  });
  assert.equal(above.y, 0);
  assert.equal(above.x, 0);
  assert.equal(above.height, 288);

  assert.equal(PANEL_MAX_INSET, 16);
  assert.equal(panelMaxHeight(700), 684);
  assert.equal(panelMaxHeight(10), 0);
  const main = readFileSync("src/main.js", "utf8");
  const css = readFileSync("src/style.css", "utf8");
  assert.match(main, /clampWindowToWorkArea\(/);
  assert.match(css, /\.app-root\s*\{[^}]*justify-content:\s*flex-start;/s);
  assert.match(css, /max-height:\s*calc\(100vh - 16px\)/);
  assert.match(css, /\.drug-collapsed\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.recommendation-text\s*\{[^}]*height:\s*calc\(1\.4em \* 2\);/s);
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
  assert.equal(
    suggestionRuleFor({ atcCode: "4,84", activeIngredient: "C10AA05", productName: "LIPITOR F.C.TAB" })
      ?.id,
    "statin",
  );
  assert.equal(suggestionRuleFor({ atcCode: "", productName: "LIPITOR F.C.TAB" })?.id, "statin");
  assert.equal(
    suggestionRuleFor({ atcCode: "2,65", activeIngredient: "N02BE01", productName: "PANADOL ACTIFAST" }),
    null,
  );
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
  assert.equal(collapsedSideEffectCountLabel(2), "2 παρεν.");
  assert.equal(collapsedSideEffectCountLabel(1), "1 παρεν.");
  assert.equal(collapsedSideEffectCountLabel(0), "");
  const main = readFileSync("src/main.js", "utf8");
  assert.match(
    main,
    /makeTag\("💡", true, \{ title: "Πρόταση", label: "Πρόταση", role: "img" \}\)/,
  );
  assert.match(main, /collapsedSideEffectCountLabel\(chipCount\)/);
  assert.equal(main.includes('makeTag("💡 Πρόταση"'), false);
  assert.match(main, /💡 Δες πρόταση/);
  assert.match(main, /basketSuggestionKind\(drug\)/);
  assert.match(main, /basketExpandedId\(scannedDrugs, expandedDrugId\)/);
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /\.orb\s*\{[^}]*--orb-size:\s*144px;/s);
  assert.match(css, /\.orb-dock\s*\{[^}]*padding-top:\s*12px;/s);
  assert.match(css, /\.basket-bar\s*\{[^}]*background:\s*#0e1216;/s);
  assert.equal(/\.orb-glass-plate\s*\{[^}]*top:\s*-4px/.test(css), false);
  const panadol = {
    productName: "PANADOL ACTIFAST",
    atcCode: "2,65",
    activeIngredient: "N02BE01",
    recommendation: "Μαζί με το Panadol, μια αναβράζουσα βιταμίνη C για το κρυολόγημα.",
    status: "done",
  };
  assert.equal(basketSuggestionKind(panadol), "ready");
  assert.equal(
    basketSuggestionKind({ ...panadol, recommendation: null, status: "loading" }),
    "pending",
  );
  assert.equal(
    basketSuggestionKind({ ...panadol, recommendation: "", status: "done" }),
    "none",
  );
  assert.equal(
    basketSuggestionKind({
      productName: "LIPITOR F.C.TAB",
      atcCode: "4,84",
      activeIngredient: "C10AA05",
      recommendation: null,
      status: "idle",
    }),
    "ready",
  );
  const pair = [
    { id: "panadol", productName: "PANADOL" },
    { id: "lipitor", productName: "LIPITOR" },
  ];
  assert.equal(basketExpandedId(pair, null), "panadol");
  assert.equal(basketExpandedId(pair, "lipitor"), "lipitor");
  assert.equal(basketCountLabel(3), "3 προϊόντα");
  assert.equal(CUSTOMER_IDLE_MS, 120000);
  assert.equal(
    cardMetaLine({ formLabel: "Επικαλ. δισκία", clock: "15:06", count: 1 }),
    "Επικαλ. δισκία · 15:06",
  );
  assert.equal(cardMetaLine({ index: 1, count: 3, clock: "15:06" }), "1 από 3 · 15:06");
  assert.equal(dosageFormLabel("AUGMENTIN F.C.TAB (875+125)MG"), "Επικαλ. δισκία");
});

test("the recommendation prompt does not recite side effects", () => {
  const source = readFileSync("supabase/functions/get-ai-recommendation/index.ts", "utf8");
  assert.match(source, /Μην αναφέρεις παρενέργειες στην πρόταση/);
});

const PANADOL_ACTIFAST_EXCERPT =
  "Οι ανεπιθύμητες ενέργειες από ιστορικά δεδομένα κλινικών μελετών είναι σπάνιες και από μικρό αριθμό ασθενών. Αντίστοιχα, οι ανεπιθύμητες ενέργειες που έχουν αναφερθεί από την εκτενή εμπειρία μετά τ...";

test("panadol actifast boilerplate and filler words are not chips", () => {
  assert.equal([...PANADOL_ACTIFAST_EXCERPT].length, 200);
  assert.deepEqual(sideEffectBullets(PANADOL_ACTIFAST_EXCERPT), []);
  assert.equal(visibleSideEffects(PANADOL_ACTIFAST_EXCERPT, false).bullets.length, 0);
  for (const filler of [
    "Αντίστοιχα",
    "Βλέπε",
    "παρακάτω",
    "επίσης",
    "όπως",
    "καθώς και",
    "σπάνια",
    "αναφέρθηκαν",
  ]) {
    assert.deepEqual(sideEffectBullets(filler), []);
    assert.deepEqual(sideEffectBullets(`${filler}.`), []);
  }
  assert.deepEqual(sideEffectBullets(ASPIRIN_PUBLIC_EXCERPT), []);
  assert.deepEqual(sideEffectBullets("ναυτία, εξάνθημα και ζάλη."), ["Ναυτία", "Εξάνθημα", "Ζάλη"]);
});
