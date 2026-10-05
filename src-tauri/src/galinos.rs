use crate::env_config;
use scraper::{Html, Selector};
use std::time::Duration;

pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ACCEPT_LANGUAGE: &str = "el-GR,el;q=0.9,en-US;q=0.8,en;q=0.7";

pub fn build_client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .ok()
}

/// Resolves a drug name from Galinos by GTIN (direct package URL → GTIN search).
pub async fn lookup_drug_name(barcode: &str) -> Option<String> {
    let clean_gtin = barcode.trim_start_matches('0').trim();
    if clean_gtin.is_empty() {
        return None;
    }

    let client = match build_client() {
        Some(c) => c,
        None => {
            env_config::app_log("[Galinos] Client build failed");
            return None;
        }
    };

    let direct_url = format!("https://www.galinos.gr/web/drugs/main/packages/{clean_gtin}");
    env_config::app_log(&format!("[Galinos] GET {direct_url}"));
    if let Some(html) = fetch_ok(&client, &direct_url).await {
        if let Some(name) = parse_package_h1(&html) {
            env_config::app_log(&format!("[Galinos] direct hit: {name}"));
            return Some(name);
        }
    }

    let search_url = format!("https://www.galinos.gr/web/drugs/main/search?q={clean_gtin}");
    env_config::app_log(&format!("[Galinos] direct miss → search {search_url}"));
    if let Some(html) = fetch_ok(&client, &search_url).await {
        if let Some(name) = parse_best_drug_result(&html) {
            env_config::app_log(&format!("[Galinos] search hit: {name}"));
            return Some(name);
        }
    }

    env_config::app_log(&format!("[Galinos] no result for {clean_gtin}"));
    None
}

/// Galinos search-only lookup (used for national EOF cross-referencing).
pub async fn lookup_by_search_query(query: &str) -> Option<String> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }
    let client = build_client()?;
    let search_url = format!(
        "https://www.galinos.gr/web/drugs/main/search?q={}",
        urlencoding_query(query)
    );
    env_config::app_log(&format!("[Galinos] EOF/search query → {search_url}"));
    let html = fetch_ok(&client, &search_url).await?;
    parse_best_drug_result(&html)
}

fn urlencoding_query(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "%20".to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

pub async fn fetch_ok(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = match client
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Accept-Language", ACCEPT_LANGUAGE)
        .send()
        .await
    {
        Ok(r) => r,
        Err(ex) => {
            env_config::app_log(&format!("[Galinos] Request error for {url}: {ex}"));
            return None;
        }
    };

    if !response.status().is_success() {
        env_config::app_log(&format!(
            "[Galinos] {} → HTTP {}",
            url,
            response.status().as_u16()
        ));
        return None;
    }

    response.text().await.ok()
}

fn parse_package_h1(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("h1").ok()?;
    let h1 = document.select(&selector).next()?;
    let raw = h1.text().collect::<String>();
    let cleaned = raw.replace("Συσκευασία", "").trim().to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Collects pharmaceutical links from Galinos search pages (tables + result lists).
fn collect_drug_links(html: &str) -> Vec<(bool, String)> {
    let document = Html::parse_document(html);
    let selector = match Selector::parse("a[href]") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    let skip = [
        "είσοδος",
        "εγγραφή",
        "συνδρομή",
        "account",
        "registration",
        "order",
        "content",
    ];

    let mut results = Vec::new();
    for element in document.select(&selector) {
        let href = match element.value().attr("href") {
            Some(h) => h,
            None => continue,
        };
        let is_package = href.contains("/web/drugs/main/packages/");
        let is_drug = href.contains("/web/drugs/main/drugs/");
        if !is_package && !is_drug {
            continue;
        }
        let text = element.text().collect::<String>();
        let text = text.trim();
        if text.chars().count() <= 2 {
            continue;
        }
        let lower = text.to_lowercase();
        if skip.iter().any(|s| lower.contains(s)) {
            continue;
        }
        results.push((is_package, text.to_string()));
    }
    results
}

/// Prefer package-level names; fall back to drug-level entries.
pub fn parse_best_drug_result_from_html(html: &str) -> Option<String> {
    let links = collect_drug_links(html);
    links
        .iter()
        .find(|(is_pkg, _)| *is_pkg)
        .or_else(|| links.first())
        .map(|(_, name)| name.clone())
}

fn parse_best_drug_result(html: &str) -> Option<String> {
    parse_best_drug_result_from_html(html)
}

const SIDE_EFFECTS_MAX_CHARS: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SideEffectHit {
    pub product_name: Option<String>,
    pub active_ingredient: Option<String>,
    pub atc_code: Option<String>,
    pub side_effects: String,
}

/// Public SPC excerpt ("Ανεπιθύμητες ενέργειες") for a scanned barcode.
/// Falls back to a name search when the package page has no citation.
pub async fn lookup_side_effects(
    barcode: &str,
    product_name: Option<&str>,
) -> Option<SideEffectHit> {
    let client = build_client()?;

    if is_numeric_barcode(barcode) {
        if let Some(hit) = side_effects_from_barcode(&client, barcode).await {
            return Some(hit);
        }
    }

    let query = product_name.unwrap_or("").trim();
    if query.is_empty() {
        return None;
    }
    side_effects_from_query(&client, query).await
}

fn is_numeric_barcode(barcode: &str) -> bool {
    let barcode = barcode.trim();
    barcode.len() >= 8 && barcode.chars().all(|c| c.is_ascii_digit())
}

async fn side_effects_from_barcode(client: &reqwest::Client, barcode: &str) -> Option<SideEffectHit> {
    let clean_gtin = barcode.trim_start_matches('0').trim();
    if clean_gtin.is_empty() {
        return None;
    }

    let direct_url = format!("https://www.galinos.gr/web/drugs/main/packages/{clean_gtin}");
    env_config::app_log(&format!("[Galinos] side effects GET {direct_url}"));
    if let Some(html) = fetch_ok(client, &direct_url).await {
        if let Some(hit) = side_effects_from_page(client, &html).await {
            return Some(hit);
        }
    }

    let search_url = format!("https://www.galinos.gr/web/drugs/main/search?q={clean_gtin}");
    let html = fetch_ok(client, &search_url).await?;
    let href = best_follow_href(&html)?;
    let page = fetch_ok(client, &absolute_galinos(&href)).await?;
    side_effects_from_page(client, &page).await
}

async fn side_effects_from_query(client: &reqwest::Client, query: &str) -> Option<SideEffectHit> {
    let search_url = format!(
        "https://www.galinos.gr/web/drugs/main/search?q={}",
        urlencoding_query(query)
    );
    env_config::app_log(&format!("[Galinos] side effects search {search_url}"));
    let html = fetch_ok(client, &search_url).await?;
    let href = best_follow_href(&html)?;
    let page = fetch_ok(client, &absolute_galinos(&href)).await?;
    side_effects_from_page(client, &page).await
}

async fn side_effects_from_page(client: &reqwest::Client, html: &str) -> Option<SideEffectHit> {
    let spc_path = parse_spc_path(html)?;
    let spc_html = fetch_ok(client, &absolute_galinos(&spc_path)).await?;
    let side_effects = parse_adverse_effects(&spc_html)?;
    Some(SideEffectHit {
        product_name: parse_package_h1(html),
        active_ingredient: parse_active_ingredients(html),
        atc_code: parse_atc_code(html),
        side_effects,
    })
}

fn absolute_galinos(path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else if path.starts_with('/') {
        format!("https://www.galinos.gr{path}")
    } else {
        format!("https://www.galinos.gr/{path}")
    }
}

fn best_follow_href(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("a[href]").ok()?;
    let mut drug_href = None;
    for element in document.select(&selector) {
        let href = element.value().attr("href")?;
        let text = element.text().collect::<String>();
        if text.trim().chars().count() <= 2 {
            continue;
        }
        if href.contains("/web/drugs/main/packages/") {
            return Some(href.to_string());
        }
        if drug_href.is_none() && href.contains("/web/drugs/main/drugs/") {
            drug_href = Some(href.to_string());
        }
    }
    drug_href
}

/// Prefer a full 7-character ATC code (for example `N02BE01`) over parent groups.
pub fn parse_atc_code(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("a[href*='/web/drugs/main/atccodes/']").ok()?;
    let mut best: Option<String> = None;
    for element in document.select(&selector) {
        let href = element.value().attr("href")?;
        let code = href.rsplit('/').next().unwrap_or("").trim();
        if code.len() < 3 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let replace = best.as_ref().map(|current| code.len() > current.len()).unwrap_or(true);
        if replace {
            best = Some(code.to_string());
        }
    }
    best
}

pub fn parse_active_ingredients(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("a[href*='/web/drugs/main/substances/']").ok()?;
    let mut names = Vec::new();
    for element in document.select(&selector) {
        let name = element.text().collect::<String>();
        let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if name.chars().count() < 2 {
            continue;
        }
        if !names.iter().any(|existing: &String| existing == &name) {
            names.push(name);
        }
    }
    if names.is_empty() {
        None
    } else {
        Some(names.join(", "))
    }
}

/// First ΠΧΠ citation on a package or drug page.
pub fn parse_spc_path(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("a[href*='/web/drugs/main/citations/']").ok()?;
    let mut fallback = None;
    for element in document.select(&selector) {
        let href = element.value().attr("href")?;
        let text = element.text().collect::<String>();
        if text.contains("ΠΧΠ") || text.to_ascii_lowercase().contains("spc") {
            return Some(href.to_string());
        }
        if fallback.is_none() {
            fallback = Some(href.to_string());
        }
    }
    fallback
}

/// Text of the SPC heading "Ανεπιθύμητες ενέργειες", without the following section.
pub fn parse_adverse_effects(html: &str) -> Option<String> {
    let raw = extract_textile_after_heading(html, "Ανεπιθύμητες ενέργειες")?;
    let cleaned = clean_html_text(&raw);
    if cleaned.chars().count() < 8 {
        None
    } else {
        Some(truncate_chars(&cleaned, SIDE_EFFECTS_MAX_CHARS))
    }
}

fn extract_textile_after_heading(html: &str, heading: &str) -> Option<String> {
    let marker = format!("<h4>{heading}</h4>");
    let idx = html.find(&marker)?;
    let after = &html[idx + marker.len()..];
    let class_at = after.find("class=\"textile\"")?;
    let after_class = &after[class_at..];
    let open_end = after_class.find('>')?;
    let body = &after_class[open_end + 1..];
    let close = body.find("</div>")?;
    Some(body[..close].to_string())
}

fn clean_html_text(raw: &str) -> String {
    let without_breaks = raw
        .replace("<br>", " ")
        .replace("<br/>", " ")
        .replace("<br />", " ")
        .replace("</p>", " ")
        .replace("</li>", " ");
    let mut text = String::new();
    let mut in_tag = false;
    for ch in without_breaks.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            text.push(ch);
        }
    }
    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let truncated: String = value.chars().take(max_chars).collect();
    let cut = truncated
        .rfind([' ', ',', ';', '.'])
        .filter(|idx| *idx > max_chars / 2)
        .unwrap_or(truncated.len());
    format!("{}…", truncated[..cut].trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_package_link() {
        let html = r#"
            <a href="/web/drugs/main/drugs/1">DRUG NAME</a>
            <a href="/web/drugs/main/packages/2">PACKAGE NAME</a>
        "#;
        assert_eq!(parse_best_drug_result(html).as_deref(), Some("PACKAGE NAME"));
    }

    #[test]
    fn reads_adverse_effects_section_only() {
        let html = r#"
            <h4>Ανεπιθύμητες ενέργειες</h4>
            <div class="textile">
                Ρινοφαρυγγίτιδα (14%), κεφαλαλγία (13,6%) και αναιμία.
            </div>
            <h4>Υπερδοσολογία</h4>
            <div class="textile">Ναυτία και έμετος.</div>
        "#;
        assert_eq!(
            parse_adverse_effects(html).as_deref(),
            Some("Ρινοφαρυγγίτιδα (14%), κεφαλαλγία (13,6%) και αναιμία.")
        );
    }

    #[test]
    fn prefers_full_atc_and_joins_ingredients() {
        let html = r#"
            <a href="/web/drugs/main/atccodes/C02">C02</a>
            <a href="/web/drugs/main/atccodes/C02KX04">Macitentan</a>
            <a href="/web/drugs/main/substances/macitentan">Μασιτεντάνη</a>
            <a href="/web/drugs/main/substances/macitentan">Μασιτεντάνη</a>
            <a href="/web/drugs/main/citations/9">ΠΧΠ 2025: SAMPLE</a>
        "#;
        assert_eq!(parse_atc_code(html).as_deref(), Some("C02KX04"));
        assert_eq!(parse_active_ingredients(html).as_deref(), Some("Μασιτεντάνη"));
        assert_eq!(parse_spc_path(html).as_deref(), Some("/web/drugs/main/citations/9"));
    }
}
