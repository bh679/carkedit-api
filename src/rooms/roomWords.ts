// 3-letter words
const WORDS_3: readonly string[] = [
  // Family & people
  "MUM", "DAD", "KIN", "SON", "SIS", "LAD",
  // Death & ritual
  "URN", "ASH", "RIP", "DIE", "BYE", "END", "BOX", "LID", "PEW", "DIG",
  "PIT", "LAY", "SIX",
  // Nature & omen
  "YEW", "OWL", "FLY", "SKY", "ROT", "SOD",
  // God & belief
  "GOD", "SIN", "VOW", "LAW",
  // Grief & feeling
  "SOB", "CRY", "WOE", "LOW", "ILL", "OLD",
  // Violence & cause
  "AXE", "GUN", "JAB", "HIT", "WAR", "ICE", "ZAP", "MOW", "COP", "WAX",
  "RUB", "SET", "RAW", "RED", "NIL",
  // Transport (carked it)
  "CAR",
  // Life & living
  "BUD", "JOY", "NEW", "KID", "FUN", "HUG", "RUN", "EAT", "NAP", "PET",
  "AWE", "BOY", "GAL", "HOP", "PAL", "TEA", "WIN", "ZEN", "YEN", "GIG",
  // Age & time
  "AGE", "BUB", "DAY", "NOW",
];

// 4-letter words
const WORDS_4: readonly string[] = [
  // Original 100
  "DEAD", "DOOM", "DUST", "DARK", "DIRE", "DIES", "FADE", "FALL", "FATE",
  "FELL", "GONE", "GORY", "GRIM", "TOMB", "BONE", "BIER", "PALL", "WAKE",
  "PALE", "COLD", "COMA", "RUIN", "REST", "REAP", "RACK", "SOUL", "SINK",
  "SLAB", "SLAY", "SLEW", "WAIL", "WANE", "WILT", "WORM", "VEIL", "VOID",
  "KILL", "KEEN", "LAST", "LOSS", "LOOM", "MOAN", "MORT", "MUTE", "NUMB",
  "PINE", "PYRE", "PREY", "PAIN", "PASS", "PLOT", "REND", "RIFT", "RIME",
  "RITE", "RUST", "SIGH", "SEAR", "STYX", "SUNK", "TOLL", "TORN", "WEPT",
  "WEEP", "WORN", "VALE", "VILE", "GORE", "GASH", "HALT", "HUSK", "HOWL",
  "HELL", "HAZE", "LASH", "LAID", "CULL", "CHAR", "CHOP", "CROW", "DUSK",
  "GASP", "LIMP", "NULL", "BANE", "LATE", "LORN", "LOST", "MAIM", "HANG",
  "HARM", "NOIR", "OMEN", "RAGE", "RAZE", "REEK", "ROPE", "STAB", "DIRK",
  "EBON",
  // Extended set
  "ACHE", "AGED", "ALMS", "ASHY", "AXED", "BALE", "BARE", "BASH", "BAWL",
  "BEAT", "BELL", "BILE", "BITE", "BLED", "BLOT", "BODY", "BOLT", "BONY",
  "BURN", "BURY", "CARK", "CASK", "CIST", "CLAD", "CLAN", "CLAW", "CLAY",
  "CLOD", "CLOT", "COIL", "COUP", "COWL", "CUTS", "DAMP", "DANK", "DAWN",
  "DEBT", "DEED", "DEEP", "DENY", "DOLE", "DOSE", "DOUR", "DRAB", "DRAG",
  "DREG", "DROP", "DRUM", "DUEL", "DULL", "DUMB", "ECHO", "EDGE", "ENDS",
  "EVIL", "EXIT", "FACE", "FANG", "FEAR", "FEUD", "FIFE", "FIRE", "FLAG",
  "FLAY", "FLOG", "FLOW", "FOAM", "FOSS", "FOUL", "FREE", "FUME", "GALL",
  "GATE", "GHAT", "GILD", "GILT", "GLOW", "GNAW", "GOLD", "GREY", "GROT",
  "GRUE", "GUST", "HACK", "HALO", "HEIR", "HEMP", "HILT", "HISS", "HOLE",
  "HOLY", "HUNT", "HURT", "HYMN", "ICED", "IDOL", "ISLE", "JINX", "JOLT",
  "KARK", "KITH", "LACE", "LAIR", "LANK", "LEAD", "LEAF", "LEER", "LILY",
  "LIMB", "LONE", "LORD", "LURK", "LYCH", "MACE", "MARK", "MASS", "MERE",
  "MIRE", "MISS", "MOLD", "MOON", "MOPE", "MUCK", "NIGH", "OBIT", "OFFS",
  "ONCE", "OVER", "PANG", "PART", "PAST", "PEAL", "PEAT", "PEST", "PIKE",
  "PITS", "PLEA", "POCK", "POUR", "PRAY", "PROD", "PULL", "RANK", "REEF",
  "RIFE", "RING", "ROBE", "ROOT", "ROTS", "ROUT", "RUNE", "RUSE", "SCAB",
  "SEEP", "SERE", "SHED", "SHIV", "SHOT", "SHUT", "SKIN", "SLIP", "SLOW",
  "SMIT", "SNOW", "SOIL", "SONG", "SOOT", "SORE", "SPAN", "STAR", "STOP",
  "SWAN", "TAPS", "TARN", "TEAR", "THIN", "TICK", "TIDE", "TOIL", "TRAP",
  "TREE", "TUNE", "UGLY", "URGE", "VAIN", "VAST", "VIAL", "WAIF", "WAFT",
  "WARD", "WARS", "WEED", "WELL", "WELT", "WENT", "WILL", "WISP", "WOLF",
  "WORD", "WRAP", "WRIT", "YORE", "ZERO",
  // Family, love & life (required inclusions)
  "LOVE", "CARE", "BABY", "LIFE", "GRAN", "GRAM", "POPS", "MATE", "FOLK",
  "FOND", "NEXT", "WISH", "SEND",
  // Card-inspired additions
  "TAPE", "SUIT", "WICK", "PLAN", "FETE", "CASH", "COIN", "SILK", "FILM",
  "SAND", "WAVE", "GIFT", "ACRE",
  // Life & vitality
  "BORN", "GROW", "HEAL", "HOPE", "BEAM", "BOND", "FEEL", "GLEE", "GLAD", "GRIN",
  "HALE", "HOME", "JUMP", "KIND", "KNOW", "LARK", "LEAP", "MEND", "MILD", "NEST",
  "OPEN", "PERK", "PLUM", "PURE", "REAL", "RISE", "ROAM", "ROAR", "SAFE", "SAIL",
  "SAVE", "SKIP", "SLIM", "SNAP", "SOFT", "SPIN", "SWIM", "TALL", "TAME", "TEND",
  "TIME", "TREK", "TRUE", "VIBE", "WALK", "WARM", "WILD", "YARN", "YEAR", "ZEST",
  // Age & time
  "TEEN", "HOUR", "WEEK", "WHEN", "THEN", "ONLY", "WANT", "NEED", "ATOM", "DIRT",
];

// 5-letter words
const WORDS_5: readonly string[] = [
  // The body
  "SKULL", "BONES", "BLOOD", "FLESH", "ASHEN", "GAUNT", "WOUND", "STAIN",
  "BLEED", "RIGOR",
  // Burial & ceremony
  "GRAVE", "CRYPT", "VIGIL", "ALTAR", "CROSS", "DIRGE", "ELEGY", "KNELL",
  "PSALM", "INTER", "SNUFF",
  // Afterlife & spirit
  "GHOST", "SHADE", "HADES", "LIMBO", "ANGEL", "DEMON", "HAUNT",
  // Grief & emotion
  "GRIEF", "MOURN", "TEARS", "AGONY", "DREAD", "GLOOM", "BLEAK", "EERIE",
  "WEARY", "STARK", "STILL", "PEACE",
  // Death & violence
  "DEATH", "DYING", "SLAIN", "DROWN", "CHOKE", "DECAY", "CURSE", "FATAL",
  "DRAWN",
  // Card-inspired
  "ASHES", "DANCE", "PARTY", "SNAKE", "EMBER", "ABYSS", "VENOM", "CHILL",
  "THORN", "NOOSE", "SWORD", "SPORE", "SMOKE", "LANCE", "STAKE", "SPEAR",
  "FINAL",
  // Life & spirit
  "ALIVE", "BLOOM", "BIRTH", "BRAVE", "CHILD", "DREAM", "EARTH", "FAITH", "FLAME", "FLORA",
  "FRESH", "GRACE", "HEART", "HAPPY", "HUMAN", "LIGHT", "LUCKY", "MAGIC", "MERCY", "MUSIC",
  "NOBLE", "OASIS", "SMILE", "SPARK", "SWEET", "SWIFT", "TRUST", "UNITY", "VITAL", "YOUNG",
  // Age & time
  "ADULT", "GRAMP", "YEARS", "MONTH", "LOVES", "LATER", "ATOMS",
];

export const ROOM_CODE_WORDS: readonly string[] = [
  ...WORDS_3,
  ...WORDS_4,
  ...WORDS_5,
];
