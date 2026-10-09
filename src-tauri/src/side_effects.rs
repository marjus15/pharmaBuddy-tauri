use crate::catalog_cache;
use crate::env_config::{self, AppProfile};
use crate::galinos;
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct SideEffectsDto {
    pub found: bool,
    pub product_name: Option<String>,
    pub active_ingredient: Option<String>,
    pub atc_code: Option<String>,
    pub side_effects: Option<String>,
}

pub async fn fetch_side_effects(
    barcode: &str,
    product_name: Option<&str>,
    name_only: bool,
) -> SideEffectsDto {
    match env_config::current_profile() {
        AppProfile::Test => test_side_effects(barcode),
        AppProfile::Prod => {
            if !galinos_lookup_enabled() {
                return empty_side_effects();
            }
            prod_side_effects(barcode, product_name, name_only).await
        }
    }
}

/// Name to store on `barcode`, or nothing.
/// A name search is never written onto a barcode. A package page is written only
/// under its own title, and only when that title does not clash with a name
/// already cached for the barcode.
pub fn side_effect_catalog_target(
    barcode: &str,
    from_barcode_page: bool,
    page_name: Option<&str>,
    session_name: Option<&str>,
) -> Option<String> {
    if !from_barcode_page {
        return None;
    }
    let page_name = page_name.unwrap_or("").trim();
    if !catalog_cache::catalog_write_allowed_with_session(barcode, page_name, session_name) {
        return None;
    }
    Some(page_name.to_string())
}

fn galinos_lookup_enabled() -> bool {
    match env_config::get_env("GALINOS_LOOKUP_ENABLED") {
        Some(v) => !matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "no" | "off"),
        None => true,
    }
}

fn empty_side_effects() -> SideEffectsDto {
    SideEffectsDto {
        found: false,
        product_name: None,
        active_ingredient: None,
        atc_code: None,
        side_effects: None,
    }
}

fn test_side_effects(barcode: &str) -> SideEffectsDto {
    if barcode == "0000000000000" {
        return empty_side_effects();
    }
    if barcode == "1111111111111" {
        return SideEffectsDto {
            found: true,
            product_name: Some("Panadol Extra 500mg (TEST)".into()),
            active_ingredient: Some("Paracetamol / Caffeine".into()),
            atc_code: Some("N02BE51".into()),
            side_effects: Some(
                "Σπάνια δερματικό εξάνθημα ή ερυθρότητα. Σε υπερβολική δόση υπάρχει κίνδυνος ηπατικής βλάβης.".into(),
            ),
        };
    }
    SideEffectsDto {
        found: true,
        product_name: None,
        active_ingredient: Some("Test Ingredient".into()),
        atc_code: Some("N/A".into()),
        side_effects: Some("Ήπια γαστρεντερική δυσφορία σε μικρό ποσοστό ασθενών.".into()),
    }
}

async fn prod_side_effects(
    barcode: &str,
    product_name: Option<&str>,
    name_only: bool,
) -> SideEffectsDto {
    let Some(lookup) = galinos::lookup_side_effects(barcode, product_name, name_only).await else {
        env_config::app_log(&format!("[SideEffects] no SPC excerpt for {barcode}"));
        return empty_side_effects();
    };
    let hit = lookup.hit;

    let page_name = hit
        .product_name
        .clone()
        .filter(|name| !name.trim().is_empty());
    if let Some(name) = side_effect_catalog_target(
        barcode,
        lookup.cache_under_barcode,
        page_name.as_deref(),
        catalog_cache::get_session_cached(barcode).as_deref(),
    ) {
        catalog_cache::schedule_catalog_facts(
            barcode.to_string(),
            name,
            "galinos",
            hit.active_ingredient.clone(),
            hit.atc_code.clone(),
            Some(hit.side_effects.clone()),
        );
    } else {
        env_config::app_log(&format!(
            "[SideEffects] not writing catalog for {barcode} (typed name or different product)"
        ));
    }

    let resolved_name = page_name.or_else(|| {
        product_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
    });

    env_config::app_log(&format!(
        "[SideEffects] {} chars for {barcode}",
        hit.side_effects.chars().count()
    ));

    SideEffectsDto {
        found: true,
        product_name: resolved_name,
        active_ingredient: hit.active_ingredient,
        atc_code: hit.atc_code,
        side_effects: Some(hit.side_effects),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_name_is_not_written_onto_another_barcode() {
        assert_eq!(
            side_effect_catalog_target(
                "5200000000001",
                false,
                Some("ZIRCOS CAPS"),
                Some("AUGMENTIN F.C.TAB"),
            ),
            None
        );
        assert_eq!(
            side_effect_catalog_target("manual-entry", true, Some("ZIRCOS CAPS"), None),
            None
        );
        assert_eq!(
            side_effect_catalog_target(
                "5200000000001",
                true,
                Some("ZIRCOS CAPS"),
                Some("AUGMENTIN F.C.TAB"),
            ),
            None
        );
        assert_eq!(
            side_effect_catalog_target("5200000000001", true, None, None),
            None
        );
        assert_eq!(
            side_effect_catalog_target(
                "5200000000001",
                true,
                Some("AUGMENTIN F.C.TAB"),
                Some("Augmentin"),
            ),
            Some("AUGMENTIN F.C.TAB".into())
        );
    }
}
