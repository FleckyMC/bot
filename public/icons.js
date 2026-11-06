'use strict';
// Item icons for the inventory view: simple SVG shapes per item category, tinted by material.
// (Minecraft's own textures are not bundled, so categories + colors are used instead.)
window.ItemIcons = (() => {
  const SHAPES = {
    block: '<path d="M12 2.5 3.5 7v10L12 21.5 20.5 17V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/>',
    pickaxe: '<path d="M5 20 14 11"/><path d="M6 8c3-4 9-4 13 0l-3 1-2-2-3 .5z"/><path d="M14 11l2.5 2.5"/>',
    axe: '<path d="M6 21 15 6"/><path d="M13 4c3-1 6 0 7 3-3 3-6 3-8 1z"/>',
    shovel: '<path d="M7 21 16 8"/><path d="M14 3c3 0 6 3 5 6l-5 2-3-3z"/>',
    hoe: '<path d="M6 21 17 5"/><path d="M17 5c3 0 5 2 4 5l-4-1z"/>',
    sword: '<path d="M14 4l6-1-1 6L9 19l-4-4z"/><path d="M4 16l4 4M5 19l-2 2"/>',
    bow: '<path d="M6 3c10 1 15 8 15 18"/><path d="M6 3l15 18"/><path d="M6 3v0"/>',
    rod: '<path d="M4 20 19 5"/><path d="M19 5v8"/><path d="M19 13a2 2 0 1 0 2 2"/>',
    trident: '<path d="M12 3v18M6 4v5a6 6 0 0 0 12 0V4"/><path d="M6 4l-1 1M18 4l1 1"/>',
    helmet: '<path d="M5 15a7 7 0 0 1 14 0v5h-4v-3H9v3H5z"/>',
    chest: '<path d="M7 3 3 7l3 3v11h12V10l3-3-4-4-3 2h-4z"/>',
    legs: '<path d="M6 3h12v8l-2 10h-4v-9l0 9H8L6 11z"/>',
    boots: '<path d="M8 3h6v9l6 3v5H5v-5l3-1z"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    food: '<path d="M12 8c-4-3-8 0-7 5 1 4 4 8 7 6 3 2 6-2 7-6 1-5-3-8-7-5z"/><path d="M12 8c0-2 1-4 3-5"/>',
    potion: '<path d="M9 3h6M10 3v5l-5 9a3 3 0 0 0 3 5h8a3 3 0 0 0 3-5l-5-9V3"/><path d="M7.5 15h9"/>',
    gem: '<path d="M6 4h12l4 6-10 11L2 10z"/><path d="M2 10h20M9 4l-2 6 5 11 5-11-2-6"/>',
    ingot: '<path d="M3 17l4-9h13l-3 9z"/><path d="M7 8l-3 9M20 8l-3 9"/>',
    dust: '<circle cx="8" cy="15" r="2.5"/><circle cx="16" cy="14" r="3"/><circle cx="12" cy="7" r="2.5"/>',
    book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
    arrow: '<path d="M4 20 20 4M20 4h-6M20 4v6M4 20l-1-4M4 20l4 1"/>',
    bucket: '<path d="M5 7h14l-2 13H7z"/><path d="M5 7a7 3 0 0 1 14 0"/>',
    orb: '<circle cx="12" cy="12" r="8"/><path d="M8 9a5 5 0 0 1 4-2"/>',
    tool: '<path d="M14 5a4 4 0 0 0-5 5l-6 6 3 3 6-6a4 4 0 0 0 5-5l-3 3-2-2z"/>',
    stick: '<path d="M5 20 19 6"/>',
    bed: '<path d="M3 18V8M3 14h18v4M21 14v-3a3 3 0 0 0-3-3h-7v6"/>',
    egg: '<path d="M12 3c4 0 7 6 7 10a7 7 0 0 1-14 0c0-4 3-10 7-10z"/>',
    fish: '<path d="M3 12c3-5 9-6 14-2l4-3v10l-4-3c-5 4-11 3-14-2z"/><circle cx="8" cy="11" r=".8"/>',
  };
  const MATERIAL = [
    [/netherite/, '#8d7aa3'], [/diamond/, '#5eead4'], [/emerald/, '#4ade80'], [/gold|golden/, '#fbbf24'],
    [/iron|chainmail|chain/, '#cbd5e1'], [/copper/, '#fb923c'], [/stone|cobble|deepslate|andesite|diorite|granite|tuff|basalt|blackstone/, '#94a3b8'],
    [/wood|oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|plank|log|stick/, '#d6a36b'], [/leather/, '#c08457'],
    [/redstone|red_|beetroot|apple|tnt/, '#fb7185'], [/lapis|blue_|water|ocean|prismarine/, '#60a5fa'], [/coal|charcoal|obsidian|black_|bedrock/, '#64748b'],
    [/sand|bone|quartz|white_|snow|ice|end_stone|calcite/, '#e2e8f0'], [/dirt|mud|clay|terracotta|brown_/, '#b08968'], [/grass|leaves|moss|slime|green_|cactus|sapling|vine|lime_/, '#86efac'],
    [/ender|purple_|amethyst|chorus|purpur/, '#c084fc'], [/nether|magma|blaze|lava|orange_/, '#fb923c'], [/glowstone|yellow_|honey|hay|wheat|bread/, '#fde047'],
    [/pink_|magenta_/, '#f472b6'], [/cyan_|light_blue/, '#67e8f9'], [/xp|experience/, '#a3e635'],
  ];
  const kindOf = (n) => {
    if (/pickaxe/.test(n)) return 'pickaxe';
    if (/_axe$/.test(n)) return 'axe';
    if (/shovel/.test(n)) return 'shovel';
    if (/_hoe$/.test(n)) return 'hoe';
    if (/sword/.test(n)) return 'sword';
    if (/^(bow|crossbow)$/.test(n)) return 'bow';
    if (/fishing_rod|carrot_on_a_stick|warped_fungus_on_a_stick/.test(n)) return 'rod';
    if (/trident/.test(n)) return 'trident';
    if (/helmet|_cap$|turtle_helmet|skull|head/.test(n)) return 'helmet';
    if (/chestplate|_tunic$|elytra/.test(n)) return 'chest';
    if (/leggings|_pants$/.test(n)) return 'legs';
    if (/boots/.test(n)) return 'boots';
    if (/shield|totem/.test(n)) return 'shield';
    if (/experience_bottle|potion|bottle|dragon_breath/.test(n)) return 'potion';
    if (/enchanted_book|^book|writable|written|knowledge/.test(n)) return 'book';
    if (/^(arrow|spectral_arrow|tipped_arrow)$/.test(n)) return 'arrow';
    if (/bucket/.test(n)) return 'bucket';
    if (/ender_pearl|ender_eye|snowball|slime_ball|fire_charge|heart_of|nether_star|eye_of/.test(n)) return 'orb';
    if (/(^|_)(cod|salmon|pufferfish|tropical_fish)$|cooked_cod|cooked_salmon/.test(n)) return 'fish';
    if (/egg/.test(n)) return 'egg';
    if (/_bed$/.test(n)) return 'bed';
    if (/^(stick)$/.test(n)) return 'stick';
    if (/diamond$|emerald$|lapis_lazuli|quartz$|amethyst_shard|prismarine_(shard|crystals)|echo_shard/.test(n)) return 'gem';
    if (/(ingot|nugget|scrap)$|^coal$|^charcoal$/.test(n)) return 'ingot';
    if (/dust|powder|gunpowder|glowstone_dust|redstone$|sugar|bone_meal|flint$|clay_ball|brick$/.test(n)) return 'dust';
    if (/apple|bread|beef|porkchop|mutton|chicken|rabbit|carrot|potato|beetroot|melon_slice|cookie|cake|pie|stew|soup|berries|kelp|honey_bottle|golden_carrot|chorus_fruit/.test(n)) return 'food';
    if (/shears|flint_and_steel|compass|clock|spyglass|lead|name_tag|saddle|brush|map|bundle/.test(n)) return 'tool';
    return 'block';
  };
  const colorOf = (n) => { for (const [re, c] of MATERIAL) if (re.test(n)) return c; return '#b9a7e8'; };
  const classify = (name) => { const n = String(name || '').replace(/^minecraft:/, ''); return { kind: kindOf(n), color: colorOf(n) }; };
  const svg = (kind) => `<svg viewBox="0 0 24 24" aria-hidden="true">${SHAPES[kind] || SHAPES.block}</svg>`;
  return { classify, svg };
})();
