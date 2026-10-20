/**
 * Stock Universe — Nifty 50 / 100 / 200 / 500 + Small Cap constituents
 * with sector classifications for heatmap, stocks page, scanner, etc.
 *
 * Symbols are NSE trading symbols.
 * Sector map covers all 500+ stocks.
 */

export type UniverseKey = "nifty50" | "nifty100" | "nifty200" | "nifty500" | "smallcap" | "microcap" | "all";

export interface UniverseInfo {
  label: string;
  shortLabel: string;
  count: number;
}

export const UNIVERSE_META: Record<UniverseKey, UniverseInfo> = {
  nifty50:   { label: "Nifty 50",       shortLabel: "N50",   count: 50 },
  nifty100:  { label: "Nifty 100",      shortLabel: "N100",  count: 100 },
  nifty200:  { label: "Nifty 200",      shortLabel: "N200",  count: 200 },
  nifty500:  { label: "Nifty 500",      shortLabel: "N500",  count: 500 },
  smallcap:  { label: "Small Cap 250",  shortLabel: "SC250", count: 250 },
  microcap:  { label: "Microcap 250",   shortLabel: "Micro", count: 251 },
  all:       { label: "All Stocks",     shortLabel: "All",   count: 0 },
};

// ── Nifty 50 ────────────────────────────────────────────────────────────────
export const NIFTY50: string[] = [
  "ADANIENT", "ADANIPORTS", "APOLLOHOSP", "ASIANPAINT", "AXISBANK", "BAJAJ-AUTO", "BAJFINANCE", "BAJAJFINSV",
  "BEL", "BHARTIARTL", "CIPLA", "COALINDIA", "DRREDDY", "EICHERMOT", "ETERNAL", "GRASIM",
  "HCLTECH", "HDFCBANK", "HDFCLIFE", "HINDALCO", "HINDUNILVR", "ICICIBANK", "ITC", "INFY",
  "INDIGO", "JSWSTEEL", "JIOFIN", "KOTAKBANK", "LT", "M&M", "MARUTI", "MAXHEALTH",
  "NTPC", "NESTLEIND", "ONGC", "POWERGRID", "RELIANCE", "SBILIFE", "SHRIRAMFIN", "SBIN",
  "SUNPHARMA", "TCS", "TATACONSUM", "TMPV", "TATASTEEL", "TECHM", "TITAN", "TRENT",
  "ULTRACEMCO", "WIPRO",
];

// ── Nifty Next 50 (51–100) ──────────────────────────────────────────────────
const NIFTY_NEXT50: string[] = [
  "ABB", "ADANIENSOL", "ADANIGREEN", "ADANIPOWER", "AMBUJACEM", "DMART", "BAJAJHLDNG", "BANKBARODA",
  "BPCL", "BOSCHLTD", "BRITANNIA", "CGPOWER", "CANBK", "CHOLAFIN", "CUMMINSIND", "DLF",
  "DIVISLAB", "GAIL", "GODREJCP", "HDFCAMC", "HAL", "HINDZINC", "HYUNDAI", "INDHOTEL",
  "IOC", "IRFC", "JINDALSTEL", "LTM", "LODHA", "MAZDOCK", "MUTHOOTFIN", "PIDILITIND",
  "PFC", "PNB", "RECLTD", "MOTHERSON", "SHREECEM", "ENRIN", "SIEMENS", "SOLARINDS",
  "TVSMOTOR", "TATACAP", "TMCV", "TATAPOWER", "TORNTPHARM", "UNIONBANK", "UNITDSPR", "VBL",
  "VEDL", "ZYDUSLIFE",
];

// ── Nifty 101–200 ───────────────────────────────────────────────────────────
const NIFTY_101_200: string[] = [
  "360ONE", "APLAPOLLO", "AUBANK", "ATGL", "ABCAPITAL", "ALKEM", "ASHOKLEY", "ASTRAL",
  "AUROPHARMA", "BSE", "BANKINDIA", "BDL", "BHARATFORG", "BHEL", "GROWW", "BIOCON",
  "BLUESTARCO", "COCHINSHIP", "COFORGE", "COLPAL", "CONCOR", "COROMANDEL", "DABUR", "DIXON",
  "EXIDEIND", "NYKAA", "FEDERALBNK", "FORTIS", "GVT&D", "GMRAIRPORT", "GLENMARK", "GODFRYPHLP",
  "GODREJPROP", "HAVELLS", "HEROMOTOCO", "HINDPETRO", "POWERINDIA", "HUDCO", "ICICIGI", "ICICIAMC",
  "IDFCFIRSTB", "INDIANB", "IRCTC", "IREDA", "INDUSTOWER", "INDUSINDBK", "NAUKRI", "JSWENERGY",
  "JUBLFOOD", "KEI", "KPITTECH", "KALYANKJIL", "LTF", "LGEINDIA", "LICHSGFIN", "LAURUSLABS",
  "LENSKART", "LUPIN", "MRF", "M&MFIN", "MANKIND", "MARICO", "MFSL", "MOTILALOFS",
  "MPHASIS", "MCX", "NHPC", "NMDC", "NATIONALUM", "OBEROIRLTY", "OIL", "PAYTM",
  "OFSS", "POLICYBZR", "PIIND", "PAGEIND", "PATANJALI", "PERSISTENT", "PHOENIXLTD", "POLYCAB",
  "PREMIERENE", "PRESTIGE", "RADICO", "RVNL", "SBICARD", "SRF", "SAIL", "SUPREMEIND",
  "SUZLON", "SWIGGY", "TATACOMM", "TATAELXSI", "TATAINVEST", "TIINDIA", "UPL", "VMM",
  "IDEA", "VOLTAS", "WAAREEENER", "YESBANK",
];

// ── Nifty 201–500 ───────────────────────────────────────────────────────────
const NIFTY_201_500: string[] = [
  "3MINDIA", "ACC", "ACMESOLAR", "AIAENG", "AWL", "AADHARHFC", "AARTIIND", "AAVAS",
  "ABBOTINDIA", "ACE", "ACUTAAS", "ABFRL", "ABLBL", "ABREL", "ABSLAMC", "CPPLUS",
  "AEGISLOG", "AEGISVOPAK", "AFCONS", "AFFLE", "AJANTPHARM", "ABDL", "ARE&M", "AMBER",
  "ANANDRATHI", "ANANTRAJ", "ANGELONE", "ANTHEM", "ANURAS", "APARINDS", "APOLLOTYRE", "APTUS",
  "ASAHIINDIA", "ASTERDM", "ATHERENERG", "ATUL", "AIIL", "BEML", "BLS", "BAJAJHFL",
  "BALKRISIND", "BALRAMCHIN", "BANDHANBNK", "MAHABANK", "BATAINDIA", "BAYERCROP", "BELRISE", "BERGEPAINT",
  "BHARTIHEXA", "BIKAJI", "BSOFT", "BLUEDART", "BLUEJET", "BBTC", "FIRSTCRY", "BRIGADE",
  "MAPMYINDIA", "CCL", "CESC", "CIEINDIA", "CRISIL", "CANFINHOME", "CANHLIFE", "CAPLIPOINT",
  "CGCL", "CARBORUNIV", "CARTRADE", "CASTROLIND", "CEATLTD", "CEMPRO", "CENTRALBK", "CDSL",
  "CHALET", "CHAMBLFERT", "CHENNPETRO", "CHOICEIN", "CHOLAHLDNG", "CUB", "CLEAN", "COHANCE",
  "CAMS", "CONCORDBIO", "CRAFTSMAN", "CREDITACC", "CROMPTON", "CYIENT", "DCMSHRIRAM", "DOMS",
  "DALBHARAT", "DATAPATTNS", "DEEPAKFERT", "DEEPAKNTR", "DELHIVERY", "DEVYANI", "LALPATHLAB", "EIDPARRY",
  "EIHOTEL", "ELECON", "ELGIEQUIP", "EMAMILTD", "EMCURE", "EMMVEE", "ENDURANCE", "ENGINERSIN",
  "ERIS", "ESCORTS", "FACT", "FINCABLES", "FSL", "FIVESTAR", "FORCEMOT", "GABRIEL",
  "GALLANTT", "GRSE", "GICRE", "GILLETTE", "GLAND", "GLAXO", "MEDANTA", "GODIGIT",
  "GPIL", "GODREJIND", "GRANULES", "GRAPHITE", "GRAVITA", "GESHIP", "FLUOROCHEM", "GMDCLTD",
  "HEG", "HBLENGINE", "HDBFS", "HFCL", "HEXT", "HSCL", "HINDCOPPER", "HOMEFIRST",
  "HONASA", "HONAUT", "ICICIPRULI", "IDBI", "IFCI", "IIFL", "IRB", "IRCON",
  "ITCHOTELS", "ITI", "INDGN", "INDIACEM", "INDIAMART", "IEX", "IOB", "IGL",
  "INOXWIND", "INTELLECT", "IGIL", "IKS", "IPCALAB", "JBCHEPHARM", "JKCEMENT", "JBMA",
  "JKTYRE", "JMFINANCIL", "JSWCEMENT", "JSWDULUX", "JSWINFRA", "JAINREC", "JPPOWER", "J&KBANK",
  "JINDALSAW", "JSL", "JUBLINGREA", "JUBLPHARMA", "JWL", "JYOTICNC", "KPRMILL", "KAJARIACER",
  "KPIL", "KARURVYSYA", "KAYNES", "KEC", "KFINTECH", "KIRLOSENG", "KIMS", "LTTS",
  "LTFOODS", "LATENTVIEW", "THELEELA", "LEMONTREE", "LICI", "LINDEINDIA", "LLOYDSME", "MMTC",
  "MGL", "MANAPPURAM", "MRPL", "MEESHO", "MINDACORP", "MSUMI", "NATCOPHARM", "NBCC",
  "NCC", "NLCINDIA", "NSLNISP", "NTPCGREEN", "NH", "NAVA", "NAVINFLUOR", "NETWEB",
  "NEULANDLAB", "NEWGEN", "NAM-INDIA", "NIVABUPA", "NUVAMA", "NUVOCO", "OLAELEC", "OLECTRA",
  "ONESOURCE", "PCBL", "PGEL", "PNBHOUSING", "PTCIL", "PVRINOX", "PARADEEP", "PETRONET",
  "PFIZER", "PWL", "PINELABS", "PIRAMALFIN", "PPLPHARMA", "POLYMED", "POONAWALLA", "RRKABEL",
  "RBLBANK", "RHIM", "RITES", "RAILTEL", "RAINBOW", "RKFORGE", "REDINGTON", "RPOWER",
  "SBFC", "SJVN", "SAGILITY", "SAILIFE", "SAMMAANCAP", "SAPPHIRE", "SARDAEN", "SAREGAMA",
  "SCHAEFFLER", "SCHNEIDER", "SCI", "SHYAMMETL", "SIGNATURE", "SOBHA", "SONACOMS", "SONATSOFTW",
  "STARHEALTH", "SUMICHEM", "SUNTV", "SUNDARMFIN", "SPLPETRO", "SWANCORP", "SYNGENE", "SYRMA",
  "TBOTEK", "TATACHEM", "TATATECH", "TTML", "TECHNOE", "TEGA", "TEJASNET", "TENNIND",
  "NIACL", "RAMCOCEM", "THERMAX", "TIMKEN", "TITAGARH", "TORNTPOWER", "TARIL", "TRAVELFOOD",
  "TRIDENT", "TRITURBINE", "UCOBANK", "UNOMINDA", "UTIAMC", "UBL", "URBANCO", "USHAMART",
  "VTL", "VIJAYA", "WELCORP", "WELSPUNLIV", "WHIRLPOOL", "WOCKPHARMA", "ZFCVINDIA", "ZEEL",
  "ZENTEC", "ZENSARTECH", "ZYDUSWELL", "ECLERX",
];

// ── Small Cap 250 (Nifty SmallCap 250 representative) ───────────────────────
const SMALLCAP_250: string[] = [
  "ACMESOLAR", "AADHARHFC", "AARTIIND", "AAVAS", "ACE", "ACUTAAS", "ABFRL", "ABLBL",
  "ABREL", "ABSLAMC", "CPPLUS", "AEGISLOG", "AEGISVOPAK", "AFCONS", "AFFLE", "ABDL",
  "ARE&M", "AMBER", "ANANDRATHI", "ANANTRAJ", "ANGELONE", "ANURAS", "APTUS", "ASAHIINDIA",
  "ASTERDM", "ATHERENERG", "ATUL", "BEML", "BLS", "BALRAMCHIN", "BANDHANBNK", "BATAINDIA",
  "BAYERCROP", "BELRISE", "BIKAJI", "BSOFT", "BLUEDART", "BLUEJET", "BBTC", "FIRSTCRY",
  "BRIGADE", "MAPMYINDIA", "CCL", "CESC", "CIEINDIA", "CANFINHOME", "CANHLIFE", "CAPLIPOINT",
  "CGCL", "CARBORUNIV", "CARTRADE", "CASTROLIND", "CEATLTD", "CEMPRO", "CENTRALBK", "CDSL",
  "CHALET", "CHAMBLFERT", "CHENNPETRO", "CHOICEIN", "CHOLAHLDNG", "CUB", "CLEAN", "COHANCE",
  "CAMS", "CONCORDBIO", "CRAFTSMAN", "CREDITACC", "CROMPTON", "CYIENT", "DCMSHRIRAM", "DOMS",
  "DATAPATTNS", "DEEPAKFERT", "DEEPAKNTR", "DELHIVERY", "DEVYANI", "LALPATHLAB", "EIDPARRY", "EIHOTEL",
  "ELECON", "ELGIEQUIP", "EMAMILTD", "EMCURE", "EMMVEE", "ENGINERSIN", "ERIS", "FACT",
  "FINCABLES", "FSL", "FIVESTAR", "FORCEMOT", "GABRIEL", "GALLANTT", "GRSE", "GILLETTE",
  "GLAND", "GODIGIT", "GPIL", "GRANULES", "GRAPHITE", "GRAVITA", "GESHIP", "GMDCLTD",
  "HEG", "HBLENGINE", "HFCL", "HSCL", "HINDCOPPER", "HOMEFIRST", "HONASA", "IDBI",
  "IFCI", "IIFL", "IRB", "IRCON", "ITI", "INDGN", "INDIACEM", "INDIAMART",
  "IEX", "IOB", "IGL", "INOXWIND", "INTELLECT", "IGIL", "IKS", "JBCHEPHARM",
  "JBMA", "JKTYRE", "JMFINANCIL", "JSWCEMENT", "JSWDULUX", "JAINREC", "JPPOWER", "J&KBANK",
  "JINDALSAW", "JUBLINGREA", "JUBLPHARMA", "JWL", "JYOTICNC", "KAJARIACER", "KPIL", "KARURVYSYA",
  "KAYNES", "KEC", "KFINTECH", "KIRLOSENG", "KIMS", "LTFOODS", "LATENTVIEW", "THELEELA",
  "LEMONTREE", "MMTC", "MGL", "MANAPPURAM", "MRPL", "MEESHO", "MINDACORP", "MSUMI",
  "NATCOPHARM", "NBCC", "NCC", "NSLNISP", "NH", "NAVA", "NAVINFLUOR", "NETWEB",
  "NEULANDLAB", "NEWGEN", "NIVABUPA", "NUVAMA", "NUVOCO", "OLAELEC", "OLECTRA", "ONESOURCE",
  "PCBL", "PGEL", "PNBHOUSING", "PTCIL", "PVRINOX", "PARADEEP", "PFIZER", "PWL",
  "PINELABS", "PIRAMALFIN", "PPLPHARMA", "POLYMED", "POONAWALLA", "RRKABEL", "RBLBANK", "RHIM",
  "RITES", "RAILTEL", "RAINBOW", "RKFORGE", "REDINGTON", "RPOWER", "SBFC", "SAGILITY",
  "SAILIFE", "SAMMAANCAP", "SAPPHIRE", "SARDAEN", "SAREGAMA", "SCHNEIDER", "SCI", "SHYAMMETL",
  "SIGNATURE", "SOBHA", "SONACOMS", "SONATSOFTW", "STARHEALTH", "SUMICHEM", "SUNTV", "SPLPETRO",
  "SWANCORP", "SYNGENE", "SYRMA", "TBOTEK", "TATACHEM", "TATATECH", "TTML", "TECHNOE",
  "TEGA", "TEJASNET", "TENNIND", "RAMCOCEM", "TIMKEN", "TITAGARH", "TARIL", "TRAVELFOOD",
  "TRIDENT", "TRITURBINE", "UCOBANK", "UTIAMC", "URBANCO", "USHAMART", "VTL", "VIJAYA",
  "WELCORP", "WELSPUNLIV", "WHIRLPOOL", "WOCKPHARMA", "ZFCVINDIA", "ZEEL", "ZENTEC", "ZENSARTECH",
  "ZYDUSWELL", "ECLERX",
];

const MICROCAP_WATCH: string[] = [
  "DPABHUSHAN",
  "ASKAUTOLTD", "AXISCADES", "AARTIDRUGS", "AARTIPHARM", "AVL", "ADVENZYMES", "AEQUS", "AETHER",
  "AHLUCONT", "AKUMS", "APLLTD", "ALIVUS", "ALKYLAMINE", "ALOKINDS", "APOLLO", "ACI",
  "ARVINDFASN", "ARVIND", "ASHAPURMIN", "ASHOKA", "ASTRAMICRO", "ATLANTAELE", "AURIONPRO", "AVALON",
  "AVANTIFEED", "CCAVENUE", "AWFIS", "AZAD", "BAJAJELEC", "BALAMINES", "BALUFORGE", "BANCOINDIA",
  "BIRLACORPN", "BBOX", "BLACKBUCK", "BLUESTONE", "BORORENEW", "CMSINFO", "CORONA", "CSBBANK",
  "CAMPUS", "CRAMC", "CAPILLARY", "CELLO", "CENTURYPLY", "CERA", "CRIZAC", "CUPID",
  "DCBBANK", "DATAMATICS", "DIACABS", "DBL", "AGARWALEYE", "DUMMYALCAR", "DYNAMATECH", "EPL",
  "EDELWEISS", "EMIL", "ELECTCAST", "ELLEN", "EMBDL", "ENTERO", "EIEL", "EQUITASBNK",
  "ETHOSLTD", "EUREKAFORB", "FEDFINA", "FIEMIND", "FINPIPE", "UTLSOLAR", "GHCL", "GMMPFAUDLR",
  "GMRP&UI", "GRWRHITECH", "GODREJAGRO", "GOKEX", "GOKULAGRO", "GREAVESCOT", "GAEL", "GNFC",
  "GPPL", "GSFC", "HGINFRA", "HAPPSTMNDS", "HCG", "HEMIPROP", "HERITGFOOD", "HCC",
  "IFBIND", "IIFLCAPS", "INOXINDIA", "INDIAGLYCO", "INDIASHLTR", "IMFA", "INDIGOPNTS", "ICIL",
  "INOXGREEN", "IONEXCHANG", "JKLAKSHMI", "JKPAPER", "JAIBALAJI", "JAMNAAUTO", "JSFB", "JAYNECOIND",
  "JSLL", "JLHL", "JUSTDIAL", "JYOTHYLAB", "KNRCON", "KPIGREEN", "KRBL", "KRN",
  "KSB", "KANSAINER", "KTKBANK", "KSCL", "KIRLOSBROS", "KIRLPNU", "KITEX", "LXCHEM",
  "IXIGO", "LLOYDSENGG", "LLOYDSENT", "LUMAXTECH", "MOIL", "MSTCLTD", "MTARTECH", "MAHSCOOTER",
  "MAHSEAMLES", "MANORAMA", "MARKSANS", "MASTEK", "MEDPLUS", "METROPOLIS", "MIDHANI", "BECTORFOOD",
  "NEOGEN", "NESCO", "NFL", "NAZARA", "NETWORK18", "OPTIEMUS", "ORIENTCEM", "ORKLAINDIA",
  "OSWALPUMPS", "PNGJL", "PCJEWELLER", "PNCINFRA", "PTC", "PARAS", "PARKHOSPS", "PGIL",
  "PICCADIL", "POWERMECH", "PRAJIND", "PRICOLLTD", "PFOCUS", "PRSMJOHNSN", "PRIVISCL", "PRUDENT",
  "PURVA", "QPOWER", "QUESS", "RAIN", "RALLIS", "RCF", "RATEGAIN", "RATNAMANI",
  "RTNINDIA", "RTNPOWER", "RAYMONDLSL", "REDTAPE", "REFEX", "RELAXO", "RELIGARE", "RBA",
  "ROUTE", "RUBICON", "SKFINDUS", "SKFINDIA", "SKYGOLD", "SMLMAH", "SAATVIKGL", "SAFARI",
  "SAMHI", "SANDUMA", "SANOFICONR", "SANSERA", "SENCO", "STYL", "SHAILY", "SHAKTIPUMP",
  "SHARDACROP", "SHAREINDIA", "SFL", "SHILPAMED", "RENUKA", "SHRIPISTON", "SKIPPER", "SMARTWORKS",
  "SOUTHBANK", "LOTUSDEV", "STARCEMENT", "SWSOLAR", "STLTECH", "STAR", "STYRENIX", "SUBROS",
  "SUDARSCHEM", "SUDEEPPHRM", "SPARC", "SUNTECK", "SUPRIYA", "SURYAROSNI", "TARC", "TDPOWERSYS",
  "TSFINV", "TVSSCS", "TMB", "TANLA", "TEXRAIL", "THANGAMAYL", "ANUP", "THOMASCOOK",
  "THYROCARE", "TI", "TIMETECHNO", "TIPSMUSIC", "TRANSRAILL", "TRIVENI", "UJJIVANSFB", "VGUARD",
  "VMART", "VIPIND", "V2RETAIL", "WABAG", "VAIBHAVGBL", "DBREALTY", "VARROC", "MANYAVAR",
  "VIKRAMSOLR", "VIYASH", "VOLTAMP", "WAAREERTL", "WAKEFIT", "WEWORK", "WEBELSOLAR", "WELENT",
  "WESTLIFE", "YATHARTH", "ZAGGLE",
];

// ── Sector Classifications ──────────────────────────────────────────────────
export const SECTOR_MAP: Record<string, string> = {
  // IT
  TCS:"IT", INFY:"IT", HCLTECH:"IT", WIPRO:"IT", TECHM:"IT", LTIM:"IT",
  MPHASIS:"IT", COFORGE:"IT", PERSISTENT:"IT", KPITTECH:"IT", TATAELXSI:"IT",
  LATENTVIEW:"IT", HAPPSTMNDS:"IT", MASTEK:"IT", CYIENT:"IT", ECLERX:"IT",
  INTELLECT:"IT", ZENSARTECH:"IT", SONATSOFTW:"IT", LTTS:"IT", OFSS:"IT",
  NAUKRI:"IT", MAPMYINDIA:"IT", NETWEB:"IT",

  // Banks
  HDFCBANK:"Banks", ICICIBANK:"Banks", SBIN:"Banks", KOTAKBANK:"Banks",
  AXISBANK:"Banks", INDUSINDBK:"Banks", BANKBARODA:"Banks", PNB:"Banks",
  CANBK:"Banks", FEDERALBNK:"Banks", IDFCFIRSTB:"Banks", AUBANK:"Banks",
  BANDHANBNK:"Banks", RBLBANK:"Banks", YESBANK:"Banks", UNIONBANK:"Banks",
  CUB:"Banks", EQUITASBNK:"Banks", KARURVYSYA:"Banks", CENTRALBK:"Banks",
  MAHABANK:"Banks", INDIANB:"Banks", DCBBANK:"Banks", CSBBANK:"Banks",

  // Finance / NBFC
  BAJFINANCE:"Finance", BAJAJFINSV:"Finance", SHRIRAMFIN:"Finance",
  SBILIFE:"Finance", HDFCLIFE:"Finance", CHOLAFIN:"Finance", "M&MFIN":"Finance",
  MFSL:"Finance", MUTHOOTFIN:"Finance", MANAPPURAM:"Finance", SBICARD:"Finance",
  ICICIPRULI:"Finance", ICICIGI:"Finance", STARHEALTH:"Finance", LICI:"Finance",
  LICHSGFIN:"Finance", PFC:"Finance", RECLTD:"Finance", IRFC:"Finance",
  CANFINHOME:"Finance", SUNDARMFIN:"Finance", ABCAPITAL:"Finance",
  "NAM-INDIA":"Finance", JIOFIN:"Finance", PNBHOUSING:"Finance",
  MOTILALOFS:"Finance", ANGELONE:"Finance", "5PAISA":"Finance",
  CAMS:"Finance", CDSL:"Finance", BSE:"Finance", MCX:"Finance",
  NUVAMA:"Finance", ANANDRATHI:"Finance", ISEC:"Finance", UTIAMC:"Finance",
  ABSLAMC:"Finance", JMFINANCIL:"Finance", IIFL:"Finance", IIFLWAM:"Finance",
  CREDITACC:"Finance", HOMEFIRST:"Finance", AAVAS:"Finance", APTUS:"Finance",
  KFINTECH:"Finance",

  // Auto
  MARUTI:"Auto", TATAMOTORS:"Auto", "M&M":"Auto", "BAJAJ-AUTO":"Auto",
  HEROMOTOCO:"Auto", EICHERMOT:"Auto", TVSMOTOR:"Auto", MOTHERSON:"Auto",
  ESCORTS:"Auto", BALKRISIND:"Auto", BHARATFORG:"Auto", ENDURANCE:"Auto",
  EXIDEIND:"Auto", SUNDRMFAST:"Auto", SONACOMS:"Auto", JAMNAAUTO:"Auto",
  AMARAJABAT:"Auto", CEATLTD:"Auto", JKTYRE:"Auto", GABRIEL:"Auto",
  VARROC:"Auto", SUPRAJIT:"Auto", SMLISUZU:"Auto",

  // Pharma / Healthcare
  SUNPHARMA:"Pharma", DRREDDY:"Pharma", CIPLA:"Pharma", DIVISLAB:"Pharma",
  APOLLOHOSP:"Pharma", LUPIN:"Pharma", TORNTPHARM:"Pharma", ZYDUSLIFE:"Pharma",
  AUROPHARMA:"Pharma", BIOCON:"Pharma", MANKIND:"Pharma", ALKEM:"Pharma",
  IPCALAB:"Pharma", GLENMARK:"Pharma", LAURUSLABS:"Pharma", FORTIS:"Pharma",
  MAXHEALTH:"Pharma", SYNGENE:"Pharma", LALPATHLAB:"Pharma", METROPOLIS:"Pharma",
  NATCOPHARM:"Pharma", GLAND:"Pharma", JBCHEPHARM:"Pharma", ERIS:"Pharma",
  AJANTPHARM:"Pharma", MEDPLUS:"Pharma", POLYMED:"Pharma",
  SANOFI:"Pharma", GLAXO:"Pharma", BAYERCROP:"Pharma", AARTIDRUGS:"Pharma",
  AARTIPHARM:"Pharma", MEDANTA:"Pharma", YATHARTH:"Pharma",

  // Energy / Oil & Gas
  RELIANCE:"Energy", ONGC:"Energy", BPCL:"Energy", NTPC:"Energy",
  POWERGRID:"Energy", ADANIENT:"Energy", ADANIGREEN:"Energy", ADANIPOWER:"Energy",
  TATAPOWER:"Energy", JSWENERGY:"Energy", NHPC:"Energy", IOC:"Energy",
  HINDPETRO:"Energy", PETRONET:"Energy", GAIL:"Energy", IGL:"Energy",
  GUJGASLTD:"Energy", GSPL:"Energy", ATGL:"Energy", HINDOILEXP:"Energy",
  MRPL:"Energy", TORNTPOWER:"Energy", CESC:"Energy",

  // Metals & Mining
  TATASTEEL:"Metals", JSWSTEEL:"Metals", HINDALCO:"Metals", COALINDIA:"Metals",
  VEDL:"Metals", SAIL:"Metals", NMDC:"Metals", NATIONALUM:"Metals",
  HINDCOPPER:"Metals", JINDALSTEL:"Metals", JSL:"Metals", JINDALSAW:"Metals",
  WELCORP:"Metals", GRAPHITE:"Metals", HEG:"Metals", RATNAMANI:"Metals",
  TATACHEM:"Metals",

  // FMCG
  HINDUNILVR:"FMCG", ITC:"FMCG", NESTLEIND:"FMCG", BRITANNIA:"FMCG",
  TATACONSUM:"FMCG", COLPAL:"FMCG", GODREJCP:"FMCG", MARICO:"FMCG",
  DABUR:"FMCG", EMAMILTD:"FMCG", VBL:"FMCG", UNITDSPR:"FMCG", UBL:"FMCG",
  RADICO:"FMCG", PATANJALI:"FMCG", BIKAJI:"FMCG", JYOTHYLAB:"FMCG",

  // Capital Goods / Industrials
  LT:"CapGoods", SIEMENS:"CapGoods", ABB:"CapGoods", HAL:"CapGoods",
  BEL:"CapGoods", HAVELLS:"CapGoods", POLYCAB:"CapGoods", THERMAX:"CapGoods",
  CUMMINSIND:"CapGoods", CGPOWER:"CapGoods", TIINDIA:"CapGoods",
  HONAUT:"CapGoods", CROMPTON:"CapGoods", DIXON:"CapGoods",
  KEI:"CapGoods", ELGIEQUIP:"CapGoods", TIMKEN:"CapGoods",
  KALPATPOWR:"CapGoods", KEC:"CapGoods", GRINDWELL:"CapGoods",
  SCHAEFFLER:"CapGoods", SKF:"CapGoods", KIRLOSENG:"CapGoods",
  VGUARD:"CapGoods", BOSCHLTD:"CapGoods", HFCL:"CapGoods",
  COCHINSHIP:"CapGoods", GRSE:"CapGoods", MAZDOCK:"CapGoods", BDL:"CapGoods",
  BEML:"CapGoods",

  // Cement
  GRASIM:"Cement", ULTRACEMCO:"Cement", AMBUJACEM:"Cement", ACC:"Cement",
  DALBHARAT:"Cement", RAMCOCEM:"Cement", JKLAKSHMI:"Cement", BIRLACORPN:"Cement",
  NUVOCO:"Cement", STARCEMENT:"Cement", ORIENTCEM:"Cement",

  // Consumer / Retail
  TITAN:"Consumer", ASIANPAINT:"Consumer", TRENT:"Consumer", PAGEIND:"Consumer",
  BATAINDIA:"Consumer", RELAXO:"Consumer", METROBRAND:"Consumer",
  PVRINOX:"Consumer", LODHA:"Consumer", DEVYANI:"Consumer", JUBLFOOD:"Consumer",
  SHOPERSTOP:"Consumer", MANYAVAR:"Consumer", SAFARI:"Consumer",
  BERGEPAINT:"Consumer", PIDILITIND:"Consumer", IRCTC:"Consumer",
  KALYANKJIL:"Consumer", DPABHUSHAN:"Consumer",

  // Chemicals
  SRF:"Chemicals", PIIND:"Chemicals", DEEPAKNTR:"Chemicals", ATUL:"Chemicals",
  NAVINFLUOR:"Chemicals", SUMICHEM:"Chemicals", CHAMBLFERT:"Chemicals",
  GNFC:"Chemicals", GSFC:"Chemicals", COROMANDEL:"Chemicals",
  ALKYLAMINE:"Chemicals", FINEORG:"Chemicals", CLEAN:"Chemicals",
  VINATIORGA:"Chemicals", DCMSHRIRAM:"Chemicals", EIDPARRY:"Chemicals",

  // Infrastructure / Realty
  ADANIPORTS:"Infra", DLF:"Infra", GODREJPROP:"Infra", OBEROIRLTY:"Infra",
  PRESTIGE:"Infra", PHOENIXLTD:"Infra", BRIGADE:"Infra", GMRAIRPORT:"Infra",
  CONCOR:"Infra", IRCON:"Infra", RVNL:"Infra", RITES:"Infra",
  ENGINERSIN:"Infra", KNR:"Infra", IBREALEST:"Infra", KOLTEPATIL:"Infra",
  JSWINFRA:"Infra", HUDCO:"Infra",

  // Telecom / Media
  BHARTIARTL:"Telecom", INDUSTOWER:"Telecom", TATACOMM:"Telecom",
  ZEEL:"Media", SUNTV:"Media", TV18BRDCST:"Media", NETWORK18:"Media",
  SAREGAMA:"Media",

  // Logistics
  DELHIVERY:"Logistics", BLUEDART:"Logistics", ALLCARGO:"Logistics",
  TCIEXPRESS:"Logistics", GESHIP:"Logistics", REDINGTON:"Logistics",

  // Textiles
  TRIDENT:"Textiles", KPRMILL:"Textiles", LUXIND:"Textiles",
  WELSPUNLIV:"Textiles", RAYMOND:"Textiles",

  // Miscellaneous / Others
  ZOMATO:"Platform", PAYTM:"Platform", INDIAMART:"Platform",
  JUSTDIAL:"Platform", CARTRADE:"Platform", EASEMYTRIP:"Platform",
  AFFLE:"Platform",
  IEX:"Exchange", TATAINVEST:"Holding", TATATECH:"Tech",
  SUPREMEIND:"Plastics", APLAPOLLO:"Pipes", ASTRAL:"Pipes",
  MRF:"Tyres",
  PGHH:"FMCG", GILLETTE:"FMCG", "3MINDIA":"Diversified",
  WHIRLPOOL:"Consumer", HONASA:"FMCG",
  IREDA:"Finance", INDHOTEL:"Hotels", LEMONTREE:"Hotels",
  CRISIL:"Finance", RALTEL:"Telecom",
  HSCL:"Infra", FACT:"Chemicals", TATACOFFEE:"FMCG",
  EPL:"Packaging", FSL:"Pharma", VOLTAMP:"CapGoods",
  STLTECH:"Telecom", SYMPHONY:"Consumer", VOLTAS:"Consumer",
};

// ── Build universe by key ───────────────────────────────────────────────────
export function getUniverse(key: UniverseKey): string[] {
  switch (key) {
    case "nifty50":
      return NIFTY50;
    case "nifty100":
      return [...NIFTY50, ...NIFTY_NEXT50];
    case "nifty200":
      return [...NIFTY50, ...NIFTY_NEXT50, ...NIFTY_101_200];
    case "nifty500":
      return [...NIFTY50, ...NIFTY_NEXT50, ...NIFTY_101_200, ...NIFTY_201_500];
    case "smallcap":
      return SMALLCAP_250;
    case "microcap":
      return MICROCAP_WATCH;
    case "all":
      return [];
  }
}

/** Get all stock symbols that belong to a given sector */
export function getSectorStocks(sector: string): string[] {
  return Object.entries(SECTOR_MAP)
    .filter(([, s]) => s === sector)
    .map(([sym]) => sym);
}

/** Get index membership tags for a symbol */
export function getIndexMembership(symbol: string): string[] {
  const tags: string[] = [];
  if (NIFTY50.includes(symbol)) tags.push("Nifty 50");
  if ([...NIFTY50, ...NIFTY_NEXT50].includes(symbol)) tags.push("Nifty 100");
  if ([...NIFTY50, ...NIFTY_NEXT50, ...NIFTY_101_200].includes(symbol)) tags.push("Nifty 200");
  if ([...NIFTY50, ...NIFTY_NEXT50, ...NIFTY_101_200, ...NIFTY_201_500].includes(symbol)) tags.push("Nifty 500");
  if (SMALLCAP_250.includes(symbol)) tags.push("SmallCap 250");
  if (MICROCAP_WATCH.includes(symbol)) tags.push("Micro Watch");
  // F&O — Nifty 50 + Next 50 are typically F&O stocks
  if (NIFTY50.includes(symbol) || NIFTY_NEXT50.includes(symbol)) tags.push("F&O");
  return tags;
}

export function getSector(symbol: string): string {
  return SECTOR_MAP[symbol] || "Others";
}

export function getAllSectors(symbols: string[]): string[] {
  const sectors = new Set(symbols.map(getSector));
  return Array.from(sectors).sort();
}
