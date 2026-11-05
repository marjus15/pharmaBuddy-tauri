//! Public SmPC section 4.8, keyed by the exact barcode.
//!
//! Galinos publishes only a ~200-character teaser of «Ανεπιθύμητες ενέργειες».
//! The price catalog links each barcode to that product's own SmPC page, which
//! still has the effect list. A page is used only when its title brand matches
//! the medicine we asked for, so a ZIRCOS scan cannot show another product.

use crate::env_config;
use crate::galinos;
use scraper::{Html, Selector};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const CATALOG_PAGE: &str = "https://farmako.net/el/times/times-farmakon";
const EXCERPT_MAX_CHARS: usize = 6000;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Frequency {
    VeryCommon,
    Common,
    Uncommon,
    Rare,
    VeryRare,
    Unknown,
}

impl Frequency {
    fn label(self) -> &'static str {
        match self {
            Frequency::VeryCommon => "Πολύ συχνές",
            Frequency::Common => "Συχνές",
            Frequency::Uncommon => "Όχι συχνές",
            Frequency::Rare => "Σπάνιες",
            Frequency::VeryRare => "Πολύ σπάνιες",
            Frequency::Unknown => "Μη γνωστής συχνότητας",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Frequency::VeryCommon => 0,
            Frequency::Common => 1,
            Frequency::Uncommon => 2,
            Frequency::Rare => 3,
            Frequency::VeryRare => 4,
            Frequency::Unknown => 5,
        }
    }
}

/// Side-effect excerpt for this barcode, or nothing when the page is missing
/// or belongs to a different medicine.
pub async fn lookup_excerpt(barcode: &str, product_name: Option<&str>) -> Option<String> {
    let barcode = barcode.trim();
    if barcode.len() < 8 || !barcode.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .ok()?;
    let index = spc_index(&client).await?;
    let url = index.get(barcode)?;
    env_config::app_log(&format!("[SideEffects] SPC page {url}"));
    let html = fetch_text(&client, url).await?;
    let excerpt = excerpt_for_product(&html, product_name)?;
    env_config::app_log(&format!(
        "[SideEffects] SPC {} chars for {barcode}",
        excerpt.chars().count()
    ));
    Some(excerpt)
}

/// Excerpt only when the page heading is the requested medicine.
pub fn excerpt_for_product(html: &str, requested: Option<&str>) -> Option<String> {
    if !page_matches_product(html, requested) {
        let heading = page_heading(html);
        env_config::app_log(&format!(
            "[SideEffects] SPC page «{heading}» is not {requested:?}"
        ));
        return None;
    }
    excerpt_from_spc_html(html)
}

pub fn page_matches_product(html: &str, requested: Option<&str>) -> bool {
    let Some(requested) = requested.map(str::trim).filter(|name| !name.is_empty()) else {
        return true;
    };
    match (brand_token(requested), brand_token(&page_heading(html))) {
        (Some(want), Some(got)) => want == got,
        _ => false,
    }
}

pub fn excerpt_from_spc_html(html: &str) -> Option<String> {
    let section = section_html(html)?;
    let structured = effects_from_tables(&section);
    let prose = useful_prose(&prose_outside_tables(&section));
    let mut parts = Vec::new();
    if !prose.is_empty() {
        let prose_limit = if structured.is_empty() {
            EXCERPT_MAX_CHARS
        } else {
            700
        };
        parts.push(truncate_chars(&prose, prose_limit));
    }
    if !structured.is_empty() {
        parts.push(structured);
    }
    let excerpt = parts.join(" ");
    let excerpt = excerpt.split_whitespace().collect::<Vec<_>>().join(" ");
    if excerpt.chars().count() < 8 {
        None
    } else {
        Some(truncate_chars(&excerpt, EXCERPT_MAX_CHARS))
    }
}

pub fn spc_csv_url_from_catalog_html(html: &str) -> Option<String> {
    let marker = "spcs_";
    let start = html.find(marker)?;
    let rest = &html[start..];
    let end = rest.find(".csv")?;
    let name = &rest[..end + 4];
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') {
        return None;
    }
    Some(format!("https://farmako.net/el/times/{name}"))
}

pub fn parse_spc_index(csv: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in csv.lines() {
        let Some((barcode, url)) = line.split_once(';') else {
            continue;
        };
        let barcode = barcode.trim();
        let url = url.trim();
        if barcode.len() >= 8
            && barcode.chars().all(|c| c.is_ascii_digit())
            && url.starts_with("http")
        {
            map.insert(barcode.to_string(), url.to_string());
        }
    }
    map
}

fn spc_index(client: &reqwest::Client) -> impl std::future::Future<Output = Option<HashMap<String, String>>> + '_ {
    async move {
        if let Some(cached) = index_lock().lock().ok().and_then(|guard| guard.clone()) {
            return Some(cached);
        }
        let catalog = fetch_text(client, CATALOG_PAGE).await?;
        let csv_url = spc_csv_url_from_catalog_html(&catalog)?;
        env_config::app_log(&format!("[SideEffects] SPC index {csv_url}"));
        let csv = fetch_text(client, &csv_url).await?;
        let map = parse_spc_index(&csv);
        if map.is_empty() {
            return None;
        }
        if let Ok(mut guard) = index_lock().lock() {
            *guard = Some(map.clone());
        }
        Some(map)
    }
}

fn index_lock() -> &'static Mutex<Option<HashMap<String, String>>> {
    static INDEX: OnceLock<Mutex<Option<HashMap<String, String>>>> = OnceLock::new();
    INDEX.get_or_init(|| Mutex::new(None))
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client
        .get(url)
        .header("User-Agent", galinos::USER_AGENT)
        .header("Accept-Language", "el-GR,el;q=0.9,en;q=0.5")
        .header("Referer", CATALOG_PAGE)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        env_config::app_log(&format!(
            "[SideEffects] SPC HTTP {} for {url}",
            response.status().as_u16()
        ));
        return None;
    }
    response.text().await.ok()
}

fn section_html(page: &str) -> Option<String> {
    let marker = page.find("id=\"sec-4-8\"")?;
    let start = page[..marker].rfind('<').unwrap_or(marker);
    let rest = &page[start..];
    let next = rest
        .find("id=\"sec-4-9\"")
        .or_else(|| rest.find("id=\"sec-5\""))
        .unwrap_or(rest.len());
    let end = rest[..next].rfind('<').unwrap_or(next);
    Some(rest[..end].to_string())
}

fn page_heading(html: &str) -> String {
    if let Some(title) = between_ci(html, "<title>", "</title>") {
        let title = plain_fragment(&title);
        if !title.is_empty() {
            return title;
        }
    }
    if let Some(h1) = between_ci(html, "<h1", "</h1>") {
        return plain_fragment(h1);
    }
    String::new()
}

fn between_ci<'a>(html: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let lower = html.to_ascii_lowercase();
    let at = lower.find(&start.to_ascii_lowercase())?;
    let from = at + start.len();
    let rest = &html[from..];
    let lower_rest = rest.to_ascii_lowercase();
    let stop = lower_rest.find(&end.to_ascii_lowercase())?;
    Some(&rest[..stop])
}

fn brand_token(value: &str) -> Option<String> {
    let folded = fold_letters_spaced(value);
    folded
        .split_whitespace()
        .find(|word| word.chars().count() >= 3)
        .map(|word| word.to_string())
}

fn effects_from_tables(section_html: &str) -> String {
    let document = Html::parse_fragment(section_html);
    let Ok(table_sel) = Selector::parse("table") else {
        return String::new();
    };
    let Ok(row_sel) = Selector::parse("tr") else {
        return String::new();
    };
    let Ok(cell_sel) = Selector::parse("td, th") else {
        return String::new();
    };
    let mut grouped: [Vec<String>; 6] = Default::default();
    for table in document.select(&table_sel) {
        let rows: Vec<Vec<String>> = table
            .select(&row_sel)
            .map(|row| {
                row.select(&cell_sel)
                    .map(|cell| join_hyphens(&cell_text(cell)))
                    .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
                    .collect()
            })
            .filter(|row: &Vec<String>| row.iter().any(|cell| !cell.is_empty()))
            .collect();
        if let Some((header_at, kinds)) = frequency_columns(&rows) {
            for row in rows.iter().skip(header_at + 1) {
                for (index, cell) in row.iter().enumerate() {
                    let Some(freq) = kinds.get(index).copied().flatten() else {
                        continue;
                    };
                    push_effects(&mut grouped, freq, cell);
                }
            }
        } else {
            for row in &rows {
                if row.len() == 2 && is_frequency_cell(&row[1]) {
                    if let Some(freq) = frequency_kind(&row[1]) {
                        push_effects(&mut grouped, freq, &row[0]);
                    }
                    continue;
                }
                if row.len() >= 3 {
                    let freq_cell = row.last().map(String::as_str).unwrap_or("");
                    let effect_cell = row.get(row.len() - 2).map(String::as_str).unwrap_or("");
                    if frequency_kind(freq_cell).is_some() && !looks_like_soc(effect_cell) {
                        zip_effects(&mut grouped, effect_cell, freq_cell);
                    }
                }
            }
        }
    }
    render_groups(&grouped)
}

fn cell_text(cell: scraper::ElementRef<'_>) -> String {
    cell.text().collect::<Vec<_>>().join(" ")
}

fn frequency_columns(rows: &[Vec<String>]) -> Option<(usize, Vec<Option<Frequency>>)> {
    for (index, row) in rows.iter().take(3).enumerate() {
        if row.len() < 3 {
            continue;
        }
        let kinds: Vec<Option<Frequency>> = row.iter().map(|cell| frequency_kind(cell)).collect();
        let hits = kinds.iter().skip(1).filter(|kind| kind.is_some()).count();
        if hits >= 2 {
            return Some((index, kinds));
        }
    }
    None
}

fn push_effects(grouped: &mut [Vec<String>; 6], freq: Frequency, cell: &str) {
    for effect in split_effects(cell) {
        let bucket = &mut grouped[freq.rank() as usize];
        if !bucket.iter().any(|existing| fold_letters(existing) == fold_letters(&effect)) {
            bucket.push(effect);
        }
    }
}

fn zip_effects(grouped: &mut [Vec<String>; 6], effects: &str, frequencies: &str) {
    let effects = split_effects(effects);
    let freqs = split_frequency_list(frequencies);
    if effects.is_empty() {
        return;
    }
    if freqs.len() == 1 {
        for effect in effects {
            push_effects(grouped, freqs[0], &effect);
        }
        return;
    }
    for (index, effect) in effects.into_iter().enumerate() {
        let freq = freqs.get(index).copied().unwrap_or(Frequency::Unknown);
        push_effects(grouped, freq, &effect);
    }
}

fn render_groups(grouped: &[Vec<String>; 6]) -> String {
    let order = [
        Frequency::VeryCommon,
        Frequency::Common,
        Frequency::Uncommon,
        Frequency::Rare,
        Frequency::VeryRare,
        Frequency::Unknown,
    ];
    order
        .into_iter()
        .filter_map(|freq| {
            let items = &grouped[freq.rank() as usize];
            if items.is_empty() {
                None
            } else {
                Some(format!("{}: {}.", freq.label(), items.join(", ")))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_effects(cell: &str) -> Vec<String> {
    let mut effects = Vec::new();
    for chunk in cell.split([',', ';', '•', '·', '|']) {
        for piece in split_capitalized(chunk) {
            if let Some(effect) = tidy_effect(&piece) {
                effects.push(effect);
            }
        }
    }
    effects
}

fn split_capitalized(text: &str) -> Vec<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut groups: Vec<Vec<&str>> = Vec::new();
    for word in words {
        let starts_upper = word.chars().next().map(char::is_uppercase).unwrap_or(false);
        if starts_upper && groups.last().is_some_and(|group| !group.is_empty()) {
            groups.push(vec![word]);
        } else if let Some(group) = groups.last_mut() {
            group.push(word);
        } else {
            groups.push(vec![word]);
        }
    }
    groups
        .into_iter()
        .map(|group| group.join(" "))
        .filter(|part| !part.is_empty())
        .collect()
}

fn tidy_effect(raw: &str) -> Option<String> {
    let mut text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    text = text
        .trim_matches(|ch: char| matches!(ch, '*' | '†' | ',' | ';' | '.' | ':' | '·' | '•'))
        .to_string();
    loop {
        let stripped = text
            .trim_end_matches(|ch: char| ch.is_ascii_digit() || ch == '*')
            .trim()
            .to_string();
        if let Some((head, last)) = stripped.rsplit_once(' ') {
            let letters: String = last.chars().filter(|ch| ch.is_alphabetic()).collect();
            if letters.chars().count() == 1 {
                text = head.to_string();
                continue;
            }
        }
        if stripped != text {
            text = stripped;
            continue;
        }
        break;
    }
    if text.chars().count() < 3 || !text.chars().any(is_greek_letter) {
        return None;
    }
    if is_frequency_cell(&text) || looks_like_soc(&text) || is_legend_fragment(&text) {
        return None;
    }
    let folded = fold_letters(&text);
    if folded == "βλ" || folded.starts_with("βλεπε") || folded.starts_with("βλπαραγραφ") {
        return None;
    }
    Some(text)
}

fn looks_like_soc(text: &str) -> bool {
    let folded = fold_letters(text);
    folded.contains("οργανικουσυστημ")
        || folded.contains("λοιμωξειςκαιπαρασιτ")
        || folded.starts_with("διαταραχεστου")
        || folded.starts_with("κατηγοριαοργανικ")
        || folded == "οργανικοσυστημα"
        || folded == "ανεπιθυμητηενεργεια"
        || folded == "ψυχιατρικεςδιαταραχες"
        || folded == "οφθαλμικεςδιαταραχες"
}

fn is_legend_fragment(text: &str) -> bool {
    text.contains('≥') || text.contains('≤') || text.contains('>') || text.contains('<')
}

fn is_frequency_cell(text: &str) -> bool {
    let letters = fold_letters(text);
    letters.chars().count() < 24 && frequency_from_compact(&letters).is_some()
}

fn frequency_kind(text: &str) -> Option<Frequency> {
    let head: String = fold_letters_spaced(text)
        .chars()
        .filter(|ch| ch.is_alphabetic() || ch.is_whitespace())
        .take(32)
        .collect();
    let compact: String = head.chars().filter(|ch| ch.is_alphabetic()).collect();
    frequency_from_compact(&compact)
}

fn split_frequency_list(text: &str) -> Vec<Frequency> {
    let compact = fold_letters(text);
    let mut found = Vec::new();
    let mut index = 0;
    let chars: Vec<char> = compact.chars().collect();
    while index < chars.len() {
        let rest: String = chars[index..].iter().collect();
        let matched = [
            ("μηγνωστ", Frequency::Unknown, 8),
            ("πολυσπαν", Frequency::VeryRare, 8),
            ("πολυσυχν", Frequency::VeryCommon, 8),
            ("πολυσυνηθ", Frequency::VeryCommon, 9),
            ("οχισυχν", Frequency::Uncommon, 7),
            ("οχισυνηθ", Frequency::Uncommon, 8),
            ("σπαν", Frequency::Rare, 4),
            ("συνηθ", Frequency::Common, 5),
            ("συχν", Frequency::Common, 4),
        ]
        .into_iter()
        .find(|(needle, _, _)| rest.starts_with(needle));
        if let Some((_, freq, len)) = matched {
            found.push(freq);
            index += len;
        } else {
            index += 1;
        }
    }
    found
}

fn frequency_from_compact(compact: &str) -> Option<Frequency> {
    if compact.contains("μηγνωστ") {
        Some(Frequency::Unknown)
    } else if compact.contains("πολυσπαν") {
        Some(Frequency::VeryRare)
    } else if compact.contains("πολυσυχν") || compact.contains("πολυσυνηθ") {
        Some(Frequency::VeryCommon)
    } else if compact.contains("οχισυχν") || compact.contains("οχισυνηθ") {
        Some(Frequency::Uncommon)
    } else if compact.contains("σπαν") {
        Some(Frequency::Rare)
    } else if compact.contains("συνηθ") || compact.contains("συχν") {
        Some(Frequency::Common)
    } else {
        None
    }
}

fn useful_prose(text: &str) -> String {
    let mut text = text.to_string();
    for marker in [
        "Αναφορά πιθανολογούμενων",
        "http://",
        "https://",
        "www.eof",
        "www.kitrinikarta",
    ] {
        if let Some(index) = text.find(marker) {
            text.truncate(index);
        }
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn prose_outside_tables(section_html: &str) -> String {
    let without = strip_tables(section_html);
    let mut text = plain_fragment(&without);
    for heading in ["4.8 Ανεπιθύμητες ενέργειες", "4.8 Ανεπιθυμητες ενεργειες"] {
        if let Some(stripped) = text.strip_prefix(heading) {
            text = stripped.trim().to_string();
        }
    }
    text
}

fn strip_tables(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.to_ascii_lowercase().find("<table") {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        if let Some(end) = after.to_ascii_lowercase().find("</table>") {
            rest = &after[end + "</table>".len()..];
        } else {
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

fn plain_fragment(raw: &str) -> String {
    let document = Html::parse_fragment(raw);
    let text = document.root_element().text().collect::<Vec<_>>().join(" ");
    decode_basic(&join_hyphens(&text))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn join_hyphens(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if (ch == '-' || ch == '\u{00ad}') && index > 0 && chars[index - 1].is_alphabetic() {
            let mut next = index + 1;
            while next < chars.len() && chars[next].is_whitespace() {
                next += 1;
            }
            if next > index + 1 && next < chars.len() && chars[next].is_alphabetic() {
                index = next;
                continue;
            }
        }
        out.push(ch);
        index += 1;
    }
    out
}

fn decode_basic(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars).collect();
    let cut = truncated
        .rfind([' ', ',', ';', '.'])
        .filter(|index| *index > max_chars / 2)
        .unwrap_or(truncated.len());
    truncated[..cut].trim_end().to_string()
}

fn fold_letters(value: &str) -> String {
    fold_letters_spaced(value).chars().filter(|ch| ch.is_alphabetic()).collect()
}

fn fold_letters_spaced(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        let folded = fold_char(ch);
        if folded.is_alphabetic() {
            out.push(folded);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out.trim().to_string()
}

fn fold_char(ch: char) -> char {
    match ch {
        'ά' | 'Ά' | 'ὰ' | 'ᾶ' | 'ἀ' | 'ἁ' | 'ἄ' | 'ἅ' | 'ἂ' | 'ἃ' | 'ἆ' | 'ἇ' => 'α',
        'έ' | 'Έ' | 'ὲ' | 'ἐ' | 'ἑ' | 'ἔ' | 'ἕ' | 'ἒ' | 'ἓ' => 'ε',
        'ή' | 'Ή' | 'ὴ' | 'ῆ' | 'ἠ' | 'ἡ' | 'ἤ' | 'ἥ' | 'ἢ' | 'ἣ' | 'ἦ' | 'ἧ' => 'η',
        'ί' | 'Ί' | 'ὶ' | 'ῖ' | 'ἰ' | 'ἱ' | 'ἴ' | 'ἵ' | 'ἲ' | 'ἳ' | 'ἶ' | 'ἷ' | 'ϊ' | 'ΐ' | 'Ϊ' => 'ι',
        'ό' | 'Ό' | 'ὸ' | 'ὀ' | 'ὁ' | 'ὄ' | 'ὅ' | 'ὂ' | 'ὃ' => 'ο',
        'ύ' | 'Ύ' | 'ὺ' | 'ῦ' | 'ὐ' | 'ὑ' | 'ὔ' | 'ὕ' | 'ὒ' | 'ὓ' | 'ὖ' | 'ὗ' | 'ϋ' | 'ΰ' | 'Ϋ' => 'υ',
        'ώ' | 'Ώ' | 'ὼ' | 'ῶ' | 'ὠ' | 'ὡ' | 'ὤ' | 'ὥ' | 'ὢ' | 'ὣ' | 'ὦ' | 'ὧ' => 'ω',
        'ς' | 'Σ' => 'σ',
        other => {
            let lower: String = other.to_lowercase().collect();
            lower.chars().next().unwrap_or(other)
        }
    }
}

fn is_greek_letter(ch: char) -> bool {
    matches!(ch, '\u{0370}'..='\u{03FF}' | '\u{1F00}'..='\u{1FFF}')
}

#[cfg(test)]
mod tests {
    use super::*;

    const ZIRCOS_PAGE: &str = r#"
        <html><head><title>ZIRCOS 10mg/tab, Επικαλυμμένο με λεπτό υμένιο δισκίο | Farmako.net</title></head>
        <body>
        <h2 id="sec-4-8">4.8 Ανεπιθύμητες ενέργειες</h2>
        <p>Οι ανεπιθύμητες ενέργειες που παρατηρούνται με το ZIRCOS είναι συνήθως ήπιες και παροδικές.</p>
        <table>
          <tr><td>Κατηγορία Οργανικού Συστήματος</td><td>Συχνές</td><td>Σπάνιες</td><td>Πολύ σπάνιες</td></tr>
          <tr><td>Διαταραχές του νευρικού συστήματος</td><td>Κεφαλαλγία Ζάλη</td><td></td><td></td></tr>
          <tr><td>Διαταραχές του γαστρεντερικού</td><td>Δυσκοιλιότητα Ναυτία Κοιλιακό άλγος</td><td>Παγκρεατίτιδα</td><td></td></tr>
          <tr><td>Διαταραχές του μυοσκελετικού συστήματος</td><td>Μυαλγία</td><td>Ραβδομυόλυση</td><td></td></tr>
        </table>
        <h2 id="sec-4-9">4.9 Υπερδοσολογία</h2>
        </body></html>
    "#;

    const AUGMENTIN_PAGE: &str = r#"
        <html><head><title>AUGMENTIN (500+125)mg/tab | Farmako.net</title></head>
        <body>
        <h2 id="sec-4-8">4.8 Ανεπιθύμητες ενέργειες</h2>
        <p>Οι ποιο συχνά αναφερθείσες ανεπιθύμητες ενέργειες είναι διάρροια, ναυτία και έμετος.</p>
        <table>
          <tr><td>Λοιμώξεις και παρασιτώσεις</td></tr>
          <tr><td>Βλεννογονοδερματική καντιντίαση</td><td>Συχνή</td></tr>
          <tr><td>Διάρροια</td><td>Πολύ συχνή</td></tr>
          <tr><td>Κεφαλαλγία</td><td>Όχι συχνή</td></tr>
        </table>
        <p>Αναφορά πιθανολογούμενων ανεπιθύμητων ενεργειών στον Εθνικό Οργανισμό Φαρμάκων: http://www.eof.gr</p>
        <h2 id="sec-4-9">4.9 Υπερδοσολογία</h2>
        </body></html>
    "#;

    const ASPIRIN_PAGE: &str = r#"
        <html><head><title>ASPIRIN 100mg/tab, Δισκίο | Farmako.net</title></head>
        <body>
        <h2 id="sec-4-8">4.8 Ανεπιθύμητες ενέργειες</h2>
        <p>Περίληψη του προφίλ ασφαλείας Οι καταγραφόμενες ανεπιθύμητες ενέργειες βασίζονται σε αυθόρμητες αναφορές.</p>
        <table>
          <tr>
            <td>Κατηγορία/ οργανικό σύστημα</td>
            <td>Συχνές</td>
            <td>Όχι συχνές</td>
            <td>Σπάνιες</td>
            <td>Μη γνωστής συχνότητας</td>
          </tr>
          <tr><td>Διαταραχές του νευρικού συστήματος</td><td>Ζάλη</td><td></td><td></td><td></td></tr>
          <tr><td>Διαταραχές του γαστρεντερικού</td><td>Δυσπεψία</td><td>Γαστρεντερική αιμορραγία</td><td>Έλκος στομάχου</td><td></td></tr>
          <tr><td>Διαταραχές του ανοσοποιητικού συστήματος</td><td></td><td></td><td>Αναφυλακτική αντίδραση</td><td></td></tr>
        </table>
        <h2 id="sec-4-9">4.9 Υπερδοσολογία</h2>
        </body></html>
    "#;

    #[test]
    fn zircos_table_lists_common_effects_and_not_another_drug() {
        let excerpt = excerpt_for_product(ZIRCOS_PAGE, Some("ZIRCOS F.C.TAB 10MG/TAB")).unwrap();
        assert!(excerpt.contains("Συχνές:"), "{excerpt}");
        assert!(excerpt.contains("Κεφαλαλγία"), "{excerpt}");
        assert!(excerpt.contains("Ζάλη"), "{excerpt}");
        assert!(excerpt.contains("Ναυτία"), "{excerpt}");
        assert!(excerpt.contains("Μυαλγία"), "{excerpt}");
        assert!(excerpt.contains("Ραβδομυόλυση"), "{excerpt}");
        assert!(!excerpt.to_lowercase().contains("καντιντίαση"), "{excerpt}");
        assert!(!excerpt.to_lowercase().contains("αμοξικιλ"), "{excerpt}");
        assert!(excerpt_for_product(AUGMENTIN_PAGE, Some("ZIRCOS CAPS")).is_none());
    }

    #[test]
    fn augmentin_pairs_keep_diarrhoea_with_that_brand_only() {
        let excerpt = excerpt_for_product(
            AUGMENTIN_PAGE,
            Some("AUGMENTIN F.C.TAB (500+125)MG/TAB"),
        )
        .unwrap();
        assert!(excerpt.contains("διάρροια, ναυτία και έμετος"), "{excerpt}");
        assert!(excerpt.contains("Πολύ συχνές:"), "{excerpt}");
        assert!(excerpt.contains("Διάρροια"), "{excerpt}");
        assert!(excerpt.contains("καντιντίαση") || excerpt.contains("Καντιντίαση"), "{excerpt}");
        assert!(!excerpt.to_lowercase().contains("eof.gr"), "{excerpt}");
        assert!(!excerpt.contains("Εθνικό Οργανισμό"), "{excerpt}");
        assert!(excerpt_for_product(ZIRCOS_PAGE, Some("AUGMENTIN")).is_none());
    }

    #[test]
    fn aspirin_table_names_effects_past_the_safety_profile_heading() {
        let excerpt = excerpt_for_product(ASPIRIN_PAGE, Some("ASPIRIN TAB 100MG/TAB")).unwrap();
        assert!(excerpt.contains("Δυσπεψία"), "{excerpt}");
        assert!(excerpt.contains("αιμορραγία") || excerpt.contains("Αιμορραγία"), "{excerpt}");
        assert!(excerpt.contains("Ζάλη"), "{excerpt}");
        assert!(!excerpt.contains("καντιντίαση"), "{excerpt}");
    }

    #[test]
    fn csv_index_is_barcode_exact() {
        let csv = "\
2803151602011;https://example.test/zircos
2801759904025;https://example.test/augmentin
not-a-code;https://example.test/nope
";
        let map = parse_spc_index(csv);
        assert_eq!(
            map.get("2803151602011").map(String::as_str),
            Some("https://example.test/zircos")
        );
        assert_eq!(
            map.get("2801759904025").map(String::as_str),
            Some("https://example.test/augmentin")
        );
        assert!(map.get("not-a-code").is_none());
        let html = "fetch('spcs_18-01-26.csv')";
        assert_eq!(
            spc_csv_url_from_catalog_html(html).as_deref(),
            Some("https://farmako.net/el/times/spcs_18-01-26.csv")
        );
    }

    #[test]
    fn saved_public_pages_keep_each_product_on_its_own_barcode() {
        // Opt-in: the saved pages are local copies of the public SmPC HTML, not fixtures in the repo.
        let Ok(dir) = std::env::var("SPC_HTML_DIR") else {
            return;
        };
        let cases = [
            ("2803151602011", "ZIRCOS F.C.TAB 10MG", "Κεφαλαλγία", "καντιντίαση"),
            ("2801759904025", "AUGMENTIN F.C.TAB (500+125)MG", "Διάρροια", "μυαλγία"),
            ("2800232808027", "DEPON MAXIMUM", "εξάνθημα", "καντιντίαση"),
            ("2801891515011", "PANADOL ACTIFAST", "εξάνθημα", "καντιντίαση"),
            ("2802075013033", "NUROFEN EXPRESS", "ναυτία", "ροσουβαστατίνη"),
            ("2802342801028", "LIPITOR", "μυαλγία", "καντιντίαση"),
            ("2800416704022", "ASPIRIN TAB 100MG", "Δυσπεψία", "καντιντίαση"),
            ("2801864302013", "XANAX", "υπνηλία", "καντιντίαση"),
        ];
        for (barcode, name, must, must_not) in cases {
            let path = format!("{dir}/farmako-{barcode}.html");
            let html = match std::fs::read_to_string(&path) {
                Ok(html) => html,
                Err(_) => continue,
            };
            let excerpt = excerpt_for_product(&html, Some(name))
                .unwrap_or_else(|| panic!("no excerpt for {barcode}"));
            assert!(
                !excerpt.to_lowercase().contains("eof.gr"),
                "{barcode} kept a source address"
            );
            assert!(
                !excerpt.contains("Εθνικό Οργανισμό"),
                "{barcode} kept a source name"
            );
            assert!(
                excerpt.to_lowercase().contains(&must.to_lowercase()),
                "{barcode} missing {must}: {excerpt}"
            );
            assert!(
                !excerpt.to_lowercase().contains(must_not),
                "{barcode} bled {must_not}: {excerpt}"
            );
            assert!(excerpt_for_product(&html, Some("WRONGDRUG")).is_none());
        }
    }
}
