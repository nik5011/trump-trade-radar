/* ============================================================================
   政策主題 ↔ 個股對照表

   用途：把「特朗普政府提出的政策」與「他在申報中交易的股票」對接起來，
        算出政策曝險分數與「政策事件－交易」交集。

   重要說明：
   1. 政策文件的標題、日期、機關都來自 Federal Register 官方 API（即時抓取），
      本檔只提供「用哪些關鍵字去搜尋」以及「哪些產業／個股對該主題敏感」。
   2. 個股的方向（受惠／受損）是本工具的**啟發式對照**，不是事實陳述、
      也不是投資建議。方向可以依你自己的判斷修改，改完重新載入即可。
   3. 交集只代表「時間上接近」，不代表因果關係。
   ========================================================================== */

const FR = (term) =>
  `https://www.federalregister.gov/documents/search?conditions%5Bterm%5D=${encodeURIComponent(term)}`;

/* dir: 1 = 政策方向上相對受惠, -1 = 相對受損 */
export const POLICY_THEMES = [
  {
    id: 'tariffs',
    name: '關稅與貿易救濟',
    axis: '貿易',
    description:
      '提高進口關稅、反傾銷與反補貼調查，會改變進口商的成本結構：' +
      '美國本土生產者相對受惠，依賴海外供應鏈或海外營收比重高的公司相對受損。',
    keywords: ['tariff', 'antidumping', 'countervailing duty', 'import duty'],
    sources: [{ name: 'Federal Register 關稅文件', url: FR('tariff') }],
    exposed: {
      CLF: { dir: 1, reason: '美國本土鋼鐵生產者，進口關稅提高競爭對手成本' },
      NUE: { dir: 1, reason: '美國電爐鋼廠，受進口保護政策支撐' },
      STLD: { dir: 1, reason: '美國電爐鋼廠，受進口保護政策支撐' },
      DE: { dir: -1, reason: '農機出口易成貿易報復對象，海外需求受影響' },
      AAPL: { dir: -1, reason: '消費電子供應鏈高度依賴亞洲製造與組裝' },
      AMZN: { dir: -1, reason: '零售商品進口成本上升，壓縮毛利' },
      COST: { dir: -1, reason: '進口商品占比高的量販通路' },
      HD: { dir: -1, reason: '進口建材與工具成本上升' },
      WMT: { dir: -1, reason: '進口消費品成本上升' },
      NKE: { dir: -1, reason: '成衣與鞋類海外製造比重高' },
      IEMG: { dir: -1, reason: '新興市場指數，貿易戰下風險偏好下降' },
      COMT: { dir: 1, reason: '商品指數，關稅與供給干擾時通常走強' },
    },
  },
  {
    id: 'semiconductors',
    name: '半導體與出口管制',
    axis: '科技',
    description:
      '晶片出口管制與產業補貼直接影響半導體供應鏈：美國設計與設備商在管制下失去部分中國市場，' +
      '但同時獲得本土製造補貼與訂單移轉。',
    keywords: ['semiconductor', 'microelectronics', 'integrated circuit', 'export control'],
    sources: [{ name: 'Federal Register 半導體文件', url: FR('semiconductor') }],
    exposed: {
      NVDA: { dir: 0, reason: 'AI 需求受惠，但中國出貨受出口管制限制' },
      AMD: { dir: 0, reason: 'AI 需求受惠，但中國出貨受出口管制限制' },
      AVGO: { dir: 0, reason: '客製化晶片需求強，但供應鏈受管制影響' },
      MU: { dir: -1, reason: '記憶體對中國市場與價格循環高度敏感' },
      AMAT: { dir: -1, reason: '半導體設備商，中國營收占比高' },
      LRCX: { dir: -1, reason: '半導體設備商，中國營收占比高' },
      KLAC: { dir: -1, reason: '半導體設備商，中國營收占比高' },
      INTC: { dir: 1, reason: '美國本土製造與補貼政策相對受惠' },
      TSM: { dir: -1, reason: '海外製造，受關稅與地緣政治風險影響' },
      SNPS: { dir: 0, reason: 'EDA 工具，受益於晶片設計需求但不直接受關稅影響' },
      CDNS: { dir: 0, reason: 'EDA 工具，受益於晶片設計需求但不直接受關稅影響' },
      TXN: { dir: 1, reason: '美國本土晶圓產能比重高' },
    },
  },
  {
    id: 'energy',
    name: '能源開採與油氣',
    axis: '能源',
    description:
      '擴大聯邦土地油氣租賃、放寬管線與 LNG 許可，對美國上游與中游能源業者是產能與訂單利多；' +
      '油價同時受地緣政治影響。',
    keywords: ['oil', 'natural gas', 'outer continental shelf', 'pipeline', 'petroleum'],
    sources: [{ name: 'Federal Register 油氣文件', url: FR('oil and gas lease') }],
    exposed: {
      XOM: { dir: 1, reason: '美國最大上游生產商，租賃與許可放寬直接受惠' },
      CVX: { dir: 1, reason: '美國大型上游生產商，租賃與許可放寬受惠' },
      OKE: { dir: 1, reason: '油氣中游管線，產量增加帶動運輸量' },
      KMI: { dir: 1, reason: '天然氣管線，LNG 出口擴張受惠' },
      WMB: { dir: 1, reason: '天然氣管線，LNG 出口擴張受惠' },
      EQT: { dir: 1, reason: '美國最大天然氣生產商' },
      SLB: { dir: 1, reason: '油田服務，鑽井活動增加帶動需求' },
      HAL: { dir: 1, reason: '油田服務，鑽井活動增加帶動需求' },
      COMT: { dir: 1, reason: '商品指數，能源權重高' },
    },
  },
  {
    id: 'defense',
    name: '國防採購與軍費',
    axis: '國防',
    description:
      '國防預算、對外軍售與衝突事件會直接反映在國防承包商的訂單能見度上。' +
      '本 App 也會用 USAspending 的實際合約公告做交叉驗證。',
    keywords: ['defense', 'military', 'armed forces', 'missile', 'naval'],
    sources: [{ name: 'Federal Register 國防文件', url: FR('Department of Defense') }],
    exposed: {
      LMT: { dir: 1, reason: '美國最大國防承包商，飛彈與戰機訂單' },
      RTX: { dir: 1, reason: '飛彈、防空系統需求隨衝突升高' },
      GD: { dir: 1, reason: '陸軍載具與潛艦' },
      NOC: { dir: 1, reason: '長程打擊與太空系統' },
      LHX: { dir: 1, reason: '電子作戰與通訊' },
      HII: { dir: 1, reason: '海軍造船' },
      BA: { dir: 1, reason: '軍機與航太，同時受民航循環影響' },
      TDG: { dir: 1, reason: '航空零件獨家供應商，國防與民航皆受惠' },
      LDOS: { dir: 1, reason: '國防 IT 與系統整合' },
      BAH: { dir: 1, reason: '聯邦顧問服務' },
      AXON: { dir: 1, reason: '執法科技與軍警裝備' },
    },
  },
  {
    id: 'immigration',
    name: '移民執法與邊境',
    axis: '執法',
    description:
      '邊境執法、拘留與遣返能量擴張，帶動拘留設施、電子監控與執法裝備採購。',
    keywords: ['immigration', 'alien', 'detention', 'border'],
    sources: [{ name: 'Federal Register 移民文件', url: FR('immigration enforcement') }],
    exposed: {
      GEO: { dir: 1, reason: '民營拘留設施營運商' },
      CXW: { dir: 1, reason: '民營拘留設施營運商' },
      AXON: { dir: 1, reason: '電擊槍與執法穿戴裝置（含 ICE 標案）' },
      MSI: { dir: 1, reason: '公共安全通訊與邊境監控系統' },
      LMT: { dir: 1, reason: '邊境監控與感測系統' },
      PLTR: { dir: 1, reason: '政府資料分析平台，常用於執法與移民資料整合' },
    },
  },
  {
    id: 'crypto',
    name: '加密貨幣與數位資產',
    axis: '金融科技',
    description:
      '數位資產監理架構、穩定幣立法與執法態度，直接影響交易所、礦業與公司持有比特幣的評價。',
    keywords: ['digital asset', 'cryptocurrency', 'crypto', 'stablecoin', 'blockchain'],
    sources: [{ name: 'Federal Register 數位資產文件', url: FR('digital assets') }],
    exposed: {
      COIN: { dir: 1, reason: '美國最大合規交易所，監理明確化受惠' },
      MSTR: { dir: 1, reason: '大量持有比特幣，價格彈性最高' },
      HOOD: { dir: 1, reason: '零售券商，加密交易量放大手續費收入' },
      MARA: { dir: 1, reason: '比特幣礦商' },
      RIOT: { dir: 1, reason: '比特幣礦商' },
      JPM: { dir: 0, reason: '受監理鬆綁影響，但加密業務占比小' },
      GS: { dir: 0, reason: '受監理鬆綁影響，但加密業務占比小' },
      COF: { dir: -1, reason: '加密分流消費金融資金，且消費信貸循環轉弱' },
    },
  },
  {
    id: 'healthcare',
    name: '藥價與醫療保險',
    axis: '醫療',
    description:
      '最惠國藥價、處方藥定價與保險補貼調整，對藥廠毛利與保險公司給付結構影響方向相反。',
    keywords: ['prescription drug', 'drug price', 'Medicare', 'Medicaid', 'pharmaceutical', 'drug'],
    sources: [{ name: 'Federal Register 藥價文件', url: FR('prescription drug prices') }],
    exposed: {
      LLY: { dir: -1, reason: '高價減重與糖尿病藥，藥價談判直接衝擊' },
      PFE: { dir: -1, reason: '專利懸崖與藥價壓力' },
      MRK: { dir: -1, reason: '專利懸崖與藥價談判壓力' },
      ABBV: { dir: -1, reason: '免疫學高價藥品' },
      UNH: { dir: 0, reason: '給付方，藥價下降有利但醫療利用率上升不利' },
      CVS: { dir: 0, reason: 'PBM 與藥局混合模式，方向取決於最終規則' },
      HCA: { dir: 1, reason: '醫療服務量與補貼政策受惠' },
      DHR: { dir: 0, reason: '醫療儀器，需求與研究預算相關' },
    },
  },
  {
    id: 'ai-power',
    name: 'AI 與電力基礎建設',
    axis: '科技／能源',
    description:
      'AI 資料中心擴建帶動電力需求與電網設備投資，政策上放寬發電與併網許可會加速這一循環。',
    keywords: ['artificial intelligence', 'data center', 'electricity', 'electric grid', 'semiconductor manufacturing'],
    sources: [{ name: 'Federal Register AI 文件', url: FR('artificial intelligence') }],
    exposed: {
      NVDA: { dir: 1, reason: 'AI 加速器核心供應商' },
      MSFT: { dir: 1, reason: '超大規模雲端與資料中心資本支出' },
      AMZN: { dir: 1, reason: 'AWS 資料中心擴建' },
      GOOGL: { dir: 1, reason: 'TPU 與雲端資料中心' },
      META: { dir: 1, reason: 'AI 基礎建設資本支出' },
      VST: { dir: 1, reason: '獨立發電商，資料中心購電協議受惠' },
      CEG: { dir: 1, reason: '核電供應商，長約需求強' },
      NEE: { dir: 1, reason: '再生能源與電網投資' },
      ETN: { dir: 1, reason: '電力管理設備，資料中心配電受惠' },
      PWR: { dir: 1, reason: '電網工程承包商' },
      TT: { dir: 1, reason: '資料中心溫控設備' },
      LII: { dir: 1, reason: '商用空調與冷卻設備' },
      DELL: { dir: 1, reason: 'AI 伺服器出貨' },
      CDW: { dir: 1, reason: '企業 IT 設備通路' },
    },
  },
  {
    id: 'govtech',
    name: '聯邦 IT 與政府效率',
    axis: '政府採購',
    description:
      '聯邦採購規則、政府效率改革與 IT 現代化預算，直接決定政府 IT 承包商的訂單與續約。',
    keywords: ['procurement', 'Federal Acquisition', 'information technology', 'government contract'],
    sources: [{ name: 'Federal Register 聯邦採購文件', url: FR('Federal Acquisition Regulation') }],
    exposed: {
      PLTR: { dir: 1, reason: '政府資料平台，聯邦訂單成長最快' },
      BAH: { dir: 1, reason: '聯邦顧問服務' },
      LDOS: { dir: 1, reason: '國防與聯邦 IT 整合' },
      SAIC: { dir: 1, reason: '聯邦 IT 服務' },
      MSFT: { dir: 1, reason: 'Azure Government 雲端合約' },
      AMZN: { dir: 1, reason: 'AWS GovCloud 合約' },
      DELL: { dir: 1, reason: '政府終端與伺服器採購' },
      CDW: { dir: 1, reason: '政府 IT 通路商' },
      ACN: { dir: 1, reason: '聯邦顧問與系統整合' },
    },
  },
  {
    id: 'finance',
    name: '金融監理鬆綁',
    axis: '金融',
    description:
      '資本適足、壓力測試與消費金融監理鬆緊，影響銀行的資本回報與放款意願。',
    keywords: ['capital requirement', 'stress test', 'bank', 'securities'],
    sources: [{ name: 'Federal Register 金融監理文件', url: FR('capital requirements') }],
    exposed: {
      JPM: { dir: 1, reason: '大型銀行，資本規範放寬直接提高回報' },
      GS: { dir: 1, reason: '資本市場業務對監理環境敏感' },
      BAC: { dir: 1, reason: '大型銀行，資本規範放寬提高回報' },
      WFC: { dir: 1, reason: '放款限制解除受惠' },
      C: { dir: 1, reason: '大型銀行，資本規範放寬提高回報' },
      MS: { dir: 1, reason: '資本市場業務' },
      COF: { dir: -1, reason: '消費信貸，信用循環與逾期率是主要風險' },
      BX: { dir: 1, reason: '另類資產管理，鬆綁有利產品銷售' },
      'BRK.B': { dir: 0, reason: '保險與多元控股，對監理變動中性' },
    },
  },
  {
    id: 'autos',
    name: '汽車與電動車政策',
    axis: '汽車',
    description:
      '燃油效率標準、電動車補貼與排放規範的調整，會改變車廠的產品組合與成本。',
    keywords: ['fuel economy', 'emission standard', 'electric vehicle', 'automobile', 'vehicle'],
    sources: [{ name: 'Federal Register 車輛法規文件', url: FR('fuel economy standards') }],
    exposed: {
      TSLA: { dir: -1, reason: '電動車補貼與碳權收入減少' },
      GM: { dir: 1, reason: '燃油車比重高，排放規範放寬有利' },
      F: { dir: 1, reason: '燃油車比重高，排放規範放寬有利' },
      RIVN: { dir: -1, reason: '純電新創，補貼依賴度高' },
      LCID: { dir: -1, reason: '純電新創，補貼依賴度高' },
      DE: { dir: 0, reason: '農機，受排放與貿易政策雙向影響' },
    },
  },
  {
    id: 'media',
    name: '媒體與電信監理',
    axis: '媒體',
    description:
      '內容監理、廣播電視執照與電信頻譜政策，影響媒體集團與電信商。',
    keywords: ['broadcast', 'spectrum', 'communications', 'media'],
    sources: [{ name: 'Federal Register 媒體電信文件', url: FR('Federal Communications Commission') }],
    exposed: {
      DIS: { dir: -1, reason: '內容監理與執照政治風險較高' },
      CMCSA: { dir: 0, reason: '有線與內容混合，受監理與串流競爭雙面影響' },
      NFLX: { dir: 0, reason: '純串流，受傳統廣電監理影響較小' },
      META: { dir: -1, reason: '平台內容審查與責任規範風險' },
      GOOGL: { dir: -1, reason: '平台內容審查與責任規範風險' },
    },
  },
];

export const POLICY_DISCLAIMER =
  '本頁的「政策－個股」對照是本工具的啟發式設定（可自行修改 policy-map.mjs），' +
  '政策文件本身來自 Federal Register 官方 API。交易與政策事件在時間上接近，' +
  '不代表任何因果關係或違法情事，也不構成投資建議。';

export function themeById(id) {
  return POLICY_THEMES.find((t) => t.id === id) || null;
}

export function allExposedTickers() {
  const out = new Set();
  for (const theme of POLICY_THEMES) {
    for (const ticker of Object.keys(theme.exposed)) out.add(ticker);
  }
  return [...out];
}
