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
}
