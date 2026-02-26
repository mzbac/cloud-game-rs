use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub(crate) struct EmulatorProfile {
    pub(crate) core: String,
    pub(crate) config: Option<String>,
}

const DEFAULT_GAME_EXTENSIONS: [&str; 12] = [
    "zip", "nes", "gba", "gbc", "gb", "smc", "fig", "bs", "cue", "v64", "n64", "z64",
];

pub(crate) fn resolve_game_path() -> Result<PathBuf, String> {
    let roots = resolve_asset_roots();

    if let Ok(override_path) = env::var("WORKER_DEFAULT_GAME") {
        let trimmed = override_path.trim();
        if let Some(path) = resolve_path_from_roots(trimmed, &roots) {
            return Ok(path);
        }
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.exists() {
                return Ok(candidate);
            }
            return Err(format!(
                "WORKER_DEFAULT_GAME was set to '{trimmed}' but the path was not found. \
Try an absolute path, or mount ROMs under assets/games and set WORKER_ASSETS_ROOT."
            ));
        }
    }

    if let Some(path) = discover_first_game_from_assets(&roots) {
        return Ok(path);
    }

    let mut searched = Vec::new();
    for root in &roots {
        searched.push(root.join("assets/games"));
        searched.push(root.join("games"));
    }
    searched.sort();
    searched.dedup();

    Err(format!(
        "No game ROMs found. Set WORKER_DEFAULT_GAME (e.g. 'assets/games/kof97.zip') \
or add ROMs under one of: {}",
        searched
            .iter()
            .map(|path| path.to_string_lossy())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

pub(crate) fn resolve_game_name(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("cloud-game")
        .replace('_', " ")
}

pub(crate) fn profile_for_game(path: &Path) -> EmulatorProfile {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    let roots = resolve_asset_roots();
    let mut profiles: HashMap<&str, EmulatorProfile> = HashMap::new();

    profiles.insert(
        "gba",
        EmulatorProfile {
            core: resolve_core_path("assets/emulator/libretro/cores/mgba_libretro", &roots),
            config: None,
        },
    );
    profiles.insert(
        "gbc",
        EmulatorProfile {
            core: resolve_core_path("assets/emulator/libretro/cores/mgba_libretro", &roots),
            config: None,
        },
    );
    profiles.insert(
        "cue",
        EmulatorProfile {
            core: resolve_core_path(
                "assets/emulator/libretro/cores/pcsx_rearmed_libretro",
                &roots,
            ),
            config: None,
        },
    );
    profiles.insert(
        "zip",
        EmulatorProfile {
            core: resolve_core_path("assets/emulator/libretro/cores/fbneo_libretro", &roots),
            config: None,
        },
    );
    profiles.insert(
        "nes",
        EmulatorProfile {
            core: resolve_core_path("assets/emulator/libretro/cores/nestopia_libretro", &roots),
            config: None,
        },
    );
    profiles.insert(
        "smc",
        EmulatorProfile {
            core: resolve_core_path(
                "assets/emulator/libretro/cores/mednafen_snes_libretro",
                &roots,
            ),
            config: None,
        },
    );
    profiles.insert(
        "fig",
        EmulatorProfile {
            core: resolve_core_path(
                "assets/emulator/libretro/cores/mednafen_snes_libretro",
                &roots,
            ),
            config: None,
        },
    );
    profiles.insert(
        "bs",
        EmulatorProfile {
            core: resolve_core_path(
                "assets/emulator/libretro/cores/mednafen_snes_libretro",
                &roots,
            ),
            config: None,
        },
    );
    let mupen_profile = EmulatorProfile {
        core: resolve_core_path(
            "assets/emulator/libretro/cores/mupen64plus_next_libretro",
            &roots,
        ),
        config: Some(resolve_asset_path(
            "assets/emulator/libretro/cores/mupen64plus_next_libretro.cfg",
            &roots,
        )),
    };
    for ext in ["v64", "n64", "z64"] {
        profiles.insert(ext, mupen_profile.clone());
    }

    profiles
        .get(extension.as_str())
        .cloned()
        .unwrap_or(EmulatorProfile {
            core: resolve_core_path("assets/emulator/libretro/cores/mgba_libretro", &roots),
            config: None,
        })
}

fn discover_first_game_from_assets(roots: &[PathBuf]) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    for root in roots {
        for dir in [root.join("assets/games"), root.join("games")] {
            candidates.extend(discover_games_in_dir(&dir));
        }
    }

    candidates.sort();
    candidates.dedup();
    candidates.retain(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .map(|name| !name.eq_ignore_ascii_case("neogeo.zip"))
            .unwrap_or(true)
    });
    candidates.into_iter().next()
}

fn discover_games_in_dir(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }

        let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
            continue;
        };
        let ext = ext.to_ascii_lowercase();
        if !DEFAULT_GAME_EXTENSIONS
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&ext))
        {
            continue;
        }

        out.push(path);
    }

    out.sort();
    out.dedup();
    out
}

fn resolve_asset_roots() -> Vec<PathBuf> {
    let mut roots = [
        env::var("WORKER_ASSETS_ROOT").unwrap_or_else(|_| ".".to_string()),
        ".".to_string(),
        "./arcade-worker".to_string(),
        "../arcade-worker".to_string(),
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect::<Vec<_>>();
    roots.sort();
    roots.dedup();
    roots.retain(|path| path.is_dir());
    roots
}

fn resolve_path_from_roots(relative_path: &str, roots: &[PathBuf]) -> Option<PathBuf> {
    let input = Path::new(relative_path);
    if input.is_absolute() && input.exists() {
        return Some(input.to_path_buf());
    }
    for root in roots {
        let candidate = root.join(input);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_asset_path(relative_path: &str, roots: &[PathBuf]) -> String {
    resolve_path_from_roots(relative_path, roots)
        .unwrap_or_else(|| PathBuf::from(relative_path))
        .to_string_lossy()
        .to_string()
}

fn resolve_core_path(core_path_no_ext: &str, roots: &[PathBuf]) -> String {
    const CORE_EXTENSIONS: [&str; 4] = [".so", ".armv7-neon-hf.so", ".dylib", ".dll"];
    let direct = Path::new(core_path_no_ext);

    if direct.is_absolute() {
        if direct.exists() {
            return direct.to_string_lossy().to_string();
        }
        for ext in CORE_EXTENSIONS {
            let candidate = PathBuf::from(format!("{core_path_no_ext}{ext}"));
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }
        return direct.to_string_lossy().to_string();
    }

    for root in roots {
        let base = root.join(core_path_no_ext);
        if base.exists() {
            return base.to_string_lossy().to_string();
        }
        for ext in CORE_EXTENSIONS {
            let candidate = PathBuf::from(format!("{}{}", base.display(), ext));
            if candidate.exists() {
                return candidate.to_string_lossy().to_string();
            }
        }
    }

    core_path_no_ext.to_string()
}
