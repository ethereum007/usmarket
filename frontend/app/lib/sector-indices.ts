/**
 * Official NSE Sector Index Constituents
 * Parsed from NSE index CSV files.
 *
 * Each sector maps to:
 * - kiteSymbol: The Kite API symbol for the sector index (for fetching index performance)
 * - constituents: Official stock list from NSE
 */

export interface SectorIndex {
  name: string;
  kiteSymbol: string;  // e.g. "NSE:NIFTY IT" for getQuote
  constituents: string[];
}

export const SECTOR_INDICES: SectorIndex[] = [
  {
    name: "Nifty IT",
    kiteSymbol: "NSE:NIFTY IT",
    constituents: ["COFORGE","HCLTECH","INFY","LTM","MPHASIS","OFSS","PERSISTENT","TCS","TECHM","WIPRO"],
  },
  {
    name: "Nifty Bank",
    kiteSymbol: "NSE:NIFTY BANK",
    constituents: ["AUBANK","AXISBANK","BANKBARODA","CANBK","FEDERALBNK","HDFCBANK","ICICIBANK","IDFCFIRSTB","INDUSINDBK","KOTAKBANK","PNB","SBIN","UNIONBANK","YESBANK"],
  },
  {
    name: "Nifty Private Bank",
    kiteSymbol: "NSE:NIFTY PVT BANK",
    constituents: ["AXISBANK","BANDHANBNK","FEDERALBNK","HDFCBANK","ICICIBANK","IDFCFIRSTB","INDUSINDBK","KOTAKBANK","RBLBANK","YESBANK"],
  },
  {
    name: "Nifty PSU Bank",
    kiteSymbol: "NSE:NIFTY PSU BANK",
    constituents: ["BANKBARODA","BANKINDIA","MAHABANK","CANBK","CENTRALBK","INDIANB","IOB","PSB","PNB","SBIN","UCOBANK","UNIONBANK"],
  },
  {
    name: "Nifty Finance",
    kiteSymbol: "NSE:NIFTY FIN SERVICE",
    constituents: ["AXISBANK","BSE","BAJFINANCE","BAJAJFINSV","CHOLAFIN","HDFCBANK","HDFCLIFE","ICICIBANK","ICICIGI","JIOFIN","KOTAKBANK","LICHSGFIN","MFSL","MUTHOOTFIN","PFC","RECLTD","SBICARD","SBILIFE","SHRIRAMFIN","SBIN"],
  },
  {
    name: "Nifty Auto",
    kiteSymbol: "NSE:NIFTY AUTO",
    constituents: ["ASHOKLEY","BAJAJ-AUTO","BHARATFORG","BOSCHLTD","EICHERMOT","EXIDEIND","HEROMOTOCO","M&M","MARUTI","MOTHERSON","SONACOMS","TVSMOTOR","TIINDIA","UNOMINDA"],
  },
  {
    name: "Nifty Pharma",
    kiteSymbol: "NSE:NIFTY PHARMA",
    constituents: ["ABBOTINDIA","AJANTPHARM","ALKEM","AUROPHARMA","BIOCON","CIPLA","DIVISLAB","DRREDDY","GLAND","GLENMARK","IPCALAB","JBCHEPHARM","LAURUSLABS","LUPIN","MANKIND","PPLPHARMA","SUNPHARMA","TORNTPHARM","WOCKPHARMA","ZYDUSLIFE"],
  },
  {
    name: "Nifty Healthcare",
    kiteSymbol: "NSE:NIFTY HEALTHCARE",
    constituents: ["ABBOTINDIA","ALKEM","APOLLOHOSP","AUROPHARMA","BIOCON","CIPLA","DIVISLAB","DRREDDY","FORTIS","GLENMARK","IPCALAB","LAURUSLABS","LUPIN","MANKIND","MAXHEALTH","PPLPHARMA","SUNPHARMA","SYNGENE","TORNTPHARM","ZYDUSLIFE"],
  },
  {
    name: "Nifty Metal",
    kiteSymbol: "NSE:NIFTY METAL",
    constituents: ["APLAPOLLO","ADANIENT","HINDALCO","HINDCOPPER","HINDZINC","JSWSTEEL","JSL","JINDALSTEL","LLOYDSME","NMDC","NATIONALUM","SAIL","TATASTEEL","VEDL","WELCORP"],
  },
  {
    name: "Nifty FMCG",
    kiteSymbol: "NSE:NIFTY FMCG",
    constituents: ["BRITANNIA","COLPAL","DABUR","EMAMILTD","GODREJCP","HINDUNILVR","ITC","MARICO","NESTLEIND","PATANJALI","RADICO","TATACONSUM","UBL","UNITDSPR","VBL"],
  },
  {
    name: "Nifty Media",
    kiteSymbol: "NSE:NIFTY MEDIA",
    constituents: ["DBCORP","HATHWAY","NAZARA","NETWORK18","PVRINOX","PFOCUS","SAREGAMA","SUNTV","TIPSMUSIC","ZEEL"],
  },
  {
    name: "Nifty Realty",
    kiteSymbol: "NSE:NIFTY REALTY",
    constituents: ["ANANTRAJ","BRIGADE","DLF","GODREJPROP","LODHA","OBEROIRLTY","PHOENIXLTD","PRESTIGE","SOBHA"],
  },
  {
    name: "Nifty Oil & Gas",
    kiteSymbol: "NSE:NIFTY OIL AND GAS",
    constituents: ["ATGL","BPCL","CASTROLIND","CHENNPETRO","GAIL","GSPL","HINDPETRO","IOC","IGL","MGL","ONGC","OIL","PETRONET","RELIANCE"],
  },
  {
    name: "Nifty Cement",
    kiteSymbol: "NSE:NIFTY CEMENT",
    constituents: ["ULTRACEMCO","GRASIM","AMBUJACEM","SHREECEM","JKCEMENT","DALBHARAT","ACC","RAMCOCEM","NUVOCO","INDIACEM","JKLAKSHMI","STARCEMENT","BIRLACORPN","PRSMJOHNSN","ORIENTCEM"],
  },
  {
    name: "Nifty Chemicals",
    kiteSymbol: "NSE:NIFTY CHEMICALS",
    constituents: ["AARTIIND","ATUL","BAYERCROP","CHAMBLFERT","COROMANDEL","DEEPAKNTR","EIDPARRY","FLUOROCHEM","GNFC","LINDEINDIA","NAVINFLUOR","PIIND","PIDILITIND","SRF","SUMICHEM","TATACHEM","UPL"],
  },
  {
    name: "Nifty Energy",
    kiteSymbol: "NSE:NIFTY ENERGY",
    constituents: ["ADANIENT","ADANIGREEN","BPCL","GAIL","HINDPETRO","IOC","NTPC","ONGC","POWERGRID","RELIANCE","TATAPOWER"],
  },
  {
    name: "Nifty Capital Markets",
    kiteSymbol: "NSE:NIFTY CAPITAL MKT",
    constituents: ["360ONE","ABSLAMC","ANANDRATHI","ANGELONE","BSE","GROWW","CDSL","CAMS","HDFCAMC","ICICIAMC","IEX","KFINTECH","MOTILALOFS","MCX","NAM-INDIA","NUVAMA","UTIAMC"],
  },
  {
    name: "Nifty Defence",
    kiteSymbol: "NSE:NIFTY DEFENCE",
    constituents: ["AXISCADES","ASTRAMICRO","BEML","BDL","BEL","BHARATFORG","COCHINSHIP","DATAPATTNS","GRSE","HAL","MTARTECH","MAZDOCK","MIDHANI","PARAS","SOLARINDS","ZENTEC"],
  },
];

/** Get all unique stock symbols across all sector indices */
export function getAllSectorStocks(): string[] {
  const set = new Set<string>();
  for (const sector of SECTOR_INDICES) {
    for (const sym of sector.constituents) {
      set.add(sym);
    }
  }
  return Array.from(set).sort();
}

/** Get all Kite index symbols for batch fetching sector performance */
export function getSectorKiteSymbols(): string[] {
  return SECTOR_INDICES.map((s) => s.kiteSymbol);
}
