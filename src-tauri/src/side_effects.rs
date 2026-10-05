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

pub async fn fetch_side_effects(barcode: &str, product_name: Option<&str>) -> SideEffectsDto {
    match env_config::current_profile() {
        AppProfile::Test => test_side_effects(barcode),
        AppProfile::Prod => {
            if !galinos_lookup_enabled() {
                return empty_side_effects();
            }
            prod_side_effects(barcode, product_name).await
        }
    }
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

async fn prod_side_effects(barcode: &str, product_name: Option<&str>) -> SideEffectsDto {
    let Some(hit) = galinos::lookup_side_effects(barcode, product_name).await else {
        env_config::app_log(&format!("[SideEffects] no SPC excerpt for {barcode}"));
        return empty_side_effects();
    };

    let resolved_name = hit
        .product_name
        .clone()
        .or_else(|| product_name.map(|name| name.trim().to_string()))
        .filter(|name| !name.is_empty());

    catalog_cache::schedule_catalog_facts(
        barcode.to_string(),
        resolved_name.clone().unwrap_or_default(),
        "galinos",
        hit.active_ingredient.clone(),
        hit.atc_code.clone(),
        Some(hit.side_effects.clone()),
    );

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
