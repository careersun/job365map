// =============================================================
// JOB365 職缺地圖 → Google 求職搜尋（Google for Jobs）職缺頁產生器
// 讀取地圖用的同一份試算表（公開 CSV），為每個職缺產生一個靜態頁面
// （內含 JobPosting 結構化資料），並產生 sitemap.xml。
// 執行：node scripts/build-jobs.mjs
// 不需安裝任何套件（Node 18+）。
// =============================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------- 1. 基本設定（請依實際狀況修改） ----------------
const CONFIG = {
  // GitHub Pages 網址，結尾不要加斜線
  SITE_URL: (process.env.SITE_URL || "https://careersun.github.io/job365map").replace(/\/$/, ""),
  // 跟地圖讀同一份試算表（需維持「知道連結的任何人皆可檢視」）
  SHEET_CSV_URL: process.env.SHEET_CSV_URL ||
    "https://docs.google.com/spreadsheets/d/1D9sqdzSZGe8Cpo-XqZKYndN5zW2WR9seazndqrw1cog/gviz/tq?tqx=out:csv&gid=0",
  // （選用）改用回傳 JSON 陣列的 Apps Script 網址
  JOBS_API_URL: process.env.JOBS_API_URL || "",
  // 本機測試用：直接讀 JSON 檔
  JOBS_JSON_FILE: process.env.JOBS_JSON_FILE || "",
  // 地圖首頁相對路徑
  MAP_PATH: "/",
  // 輸出資料夾（相對於專案根目錄）
  OUT_DIR: "jobs",

  ORG: {
    name: "日玖國際 JOB365",
    url: "https://careersun.github.io/job365map/",
    logo: "https://careersun.github.io/job365map/favicon-192.png", // 正方形、至少 112x112
  },
  // 母公司
  PARENT: {
    name: "日玖國際",
    url: "http://zjiou.com.tw/",
  },
  // 「立即應徵」按鈕連結（與地圖的 CONTACT_LINK 相同）
  APPLY_URL: "https://lin.ee/oX4esly",

  // 每頁都會出現的主要關鍵字（標題、描述、頁首）
  KEYWORD: "中基層人才所(工作・人才來就補)",

  // GA4 評估 ID（與地圖相同）；留空就不載入 GA
  GA4_ID: "G-21781Q6CNX",

  // 沒有截止日期時，自動設定為首次上架日起幾天後到期
  DEFAULT_VALID_DAYS: 45,

  // 試算表欄位名稱對應：每個欄位依序比對，第一個找到的就用
  // （已對應「職缺列表 / 工作表1」的欄位）
  FIELDS: {
    id:           ["職缺編號", "ID", "id"],
    title:        ["title", "職缺名稱", "職稱"],
    industry:     ["company", "產業"],          // 表中 company 欄放的是產業別（半導體、製造業…）
    company:      ["公司名稱", "企業名稱"],      // 真正的公司名；沒填就用 ORG.name
    category:     ["category", "職類"],
    address:      ["city", "地址", "工作地點"],
    salary:       ["salary", "薪資", "待遇"],
    hours:        ["workHours", "工作時間"],
    shift:        ["shift", "班別"],
    restDay:      ["restDay", "休假"],
    benefits:     ["benefits", "福利"],
    description:  ["info", "description", "工作內容", "職缺描述", "職缺資訊", "說明"],
    requirements: ["requirements", "應徵條件", "條件"],
    posted:       ["updated", "刊登日期", "上架日期"],
    validThrough: ["截止日期", "到期日"],
    status:       ["狀態", "招募狀態", "status"],
    link:         ["link", "應徵連結"],
  },
  // 狀態欄位含有以下任一字詞，就視為停止招募
  CLOSED_WORDS: ["停招", "停止", "關閉", "已滿", "結束", "下架", "暫停", "close", "closed"],
};

// ---------------- 2. 工具函式 ----------------
const ROOT = process.cwd();
const STATE_FILE = path.join(ROOT, CONFIG.OUT_DIR, "jobs-state.json");
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時間

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function pick(row, key) {
  for (const name of CONFIG.FIELDS[key]) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") {
      return String(row[name]).trim();
    }
  }
  return "";
}

function toDate(v) {
  if (!v) return "";
  const d = new Date(String(v).replace(/\//g, "-"));
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function jobId(row) {
  const raw = pick(row, "id");
  if (raw) return raw.replace(/[^\w-]/g, "_");
  const basis = [pick(row, "title"), pick(row, "company"), pick(row, "address")].join("|");
  return "j" + crypto.createHash("sha1").update(basis).digest("hex").slice(0, 10);
}

// 台灣鄉鎮市區 → 郵遞區號對照表
const TW_POSTAL = {
  // 臺北市
  "臺北市中正區":"100","臺北市大同區":"103","臺北市中山區":"104","臺北市松山區":"105",
  "臺北市大安區":"106","臺北市萬華區":"108","臺北市信義區":"110","臺北市士林區":"111",
  "臺北市北投區":"112","臺北市內湖區":"114","臺北市南港區":"115","臺北市文山區":"116",
  // 新北市
  "新北市萬里區":"207","新北市金山區":"208","新北市板橋區":"220","新北市汐止區":"221",
  "新北市深坑區":"222","新北市石碇區":"223","新北市瑞芳區":"224","新北市平溪區":"226",
  "新北市雙溪區":"227","新北市貢寮區":"228","新北市新店區":"231","新北市坪林區":"232",
  "新北市烏來區":"233","新北市永和區":"234","新北市中和區":"235","新北市土城區":"236",
  "新北市三峽區":"237","新北市樹林區":"238","新北市鶯歌區":"239","新北市三重區":"241",
  "新北市新莊區":"242","新北市泰山區":"243","新北市林口區":"244","新北市蘆洲區":"247",
  "新北市五股區":"248","新北市八里區":"249","新北市淡水區":"251","新北市三芝區":"252",
  "新北市石門區":"253",
  // 基隆市
  "基隆市仁愛區":"200","基隆市信義區":"201","基隆市中正區":"202","基隆市中山區":"203",
  "基隆市安樂區":"204","基隆市暖暖區":"205","基隆市七堵區":"206",
  // 桃園市
  "桃園市中壢區":"320","桃園市平鎮區":"324","桃園市龍潭區":"325","桃園市楊梅區":"326",
  "桃園市新屋區":"327","桃園市觀音區":"328","桃園市桃園區":"330","桃園市龜山區":"333",
  "桃園市八德區":"334","桃園市大溪區":"335","桃園市復興區":"336","桃園市大園區":"337",
  "桃園市蘆竹區":"338",
  // 新竹市
  "新竹市東區":"300","新竹市北區":"300","新竹市香山區":"300",
  // 新竹縣
  "新竹縣竹北市":"302","新竹縣竹北":"302","新竹縣湖口鄉":"303","新竹縣新豐鄉":"304",
  "新竹縣新埔鎮":"305","新竹縣關西鎮":"306","新竹縣芎林鄉":"307","新竹縣寶山鄉":"308",
  "新竹縣竹東鎮":"310","新竹縣五峰鄉":"311","新竹縣橫山鄉":"312","新竹縣尖石鄉":"313",
  "新竹縣北埔鄉":"314","新竹縣峨眉鄉":"315",
  // 苗栗縣
  "苗栗縣竹南鎮":"350","苗栗縣頭份市":"351","苗栗縣三灣鄉":"352","苗栗縣南庄鄉":"353",
  "苗栗縣獅潭鄉":"354","苗栗縣後龍鎮":"356","苗栗縣通霄鎮":"357","苗栗縣苑裡鎮":"358",
  "苗栗縣苗栗市":"360","苗栗縣造橋鄉":"361","苗栗縣頭屋鄉":"362","苗栗縣公館鄉":"363",
  "苗栗縣大湖鄉":"364","苗栗縣泰安鄉":"365","苗栗縣銅鑼鄉":"366","苗栗縣三義鄉":"367",
  "苗栗縣西湖鄉":"368","苗栗縣卓蘭鎮":"369",
  // 臺中市
  "臺中市中區":"400","臺中市東區":"401","臺中市南區":"402","臺中市西區":"403",
  "臺中市北區":"404","臺中市北屯區":"406","臺中市西屯區":"407","臺中市南屯區":"408",
  "臺中市太平區":"411","臺中市大里區":"412","臺中市霧峰區":"413","臺中市烏日區":"414",
  "臺中市豐原區":"420","臺中市后里區":"421","臺中市石岡區":"422","臺中市東勢區":"423",
  "臺中市和平區":"424","臺中市新社區":"426","臺中市潭子區":"427","臺中市大雅區":"428",
  "臺中市神岡區":"429","臺中市大肚區":"432","臺中市沙鹿區":"433","臺中市龍井區":"434",
  "臺中市梧棲區":"435","臺中市清水區":"436","臺中市大甲區":"437","臺中市外埔區":"438",
  "臺中市大安區":"439",
  // 彰化縣
  "彰化縣彰化市":"500","彰化縣芬園鄉":"502","彰化縣花壇鄉":"503","彰化縣秀水鄉":"504",
  "彰化縣鹿港鎮":"505","彰化縣福興鄉":"506","彰化縣線西鄉":"507","彰化縣和美鎮":"508",
  "彰化縣伸港鄉":"509","彰化縣員林市":"510","彰化縣社頭鄉":"511","彰化縣永靖鄉":"512",
  "彰化縣埔心鄉":"513","彰化縣溪湖鎮":"514","彰化縣大村鄉":"515","彰化縣埔鹽鄉":"516",
  "彰化縣田中鎮":"520","彰化縣北斗鎮":"521","彰化縣田尾鄉":"522","彰化縣埤頭鄉":"523",
  "彰化縣溪州鄉":"524","彰化縣竹塘鄉":"525","彰化縣二林鎮":"526","彰化縣大城鄉":"527",
  "彰化縣芳苑鄉":"528","彰化縣二水鄉":"530",
  // 嘉義市
  "嘉義市東區":"600","嘉義市西區":"600",
  // 臺南市
  "臺南市中西區":"700","臺南市東區":"701","臺南市南區":"702","臺南市北區":"704",
  "臺南市安平區":"708","臺南市安南區":"709","臺南市永康區":"710","臺南市歸仁區":"711",
  "臺南市新化區":"712","臺南市左鎮區":"713","臺南市玉井區":"714","臺南市楠西區":"715",
  "臺南市南化區":"716","臺南市仁德區":"717","臺南市關廟區":"718","臺南市龍崎區":"719",
  "臺南市官田區":"720","臺南市麻豆區":"721","臺南市佳里區":"722","臺南市西港區":"723",
  "臺南市七股區":"724","臺南市將軍區":"725","臺南市學甲區":"726","臺南市北門區":"727",
  "臺南市新營區":"730","臺南市後壁區":"731","臺南市白河區":"732","臺南市東山區":"733",
  "臺南市六甲區":"734","臺南市下營區":"735","臺南市柳營區":"736","臺南市鹽水區":"737",
  "臺南市善化區":"741","臺南市大內區":"742","臺南市山上區":"743","臺南市新市區":"744",
  "臺南市安定區":"745",
  // 高雄市
  "高雄市新興區":"800","高雄市前金區":"801","高雄市苓雅區":"802","高雄市鹽埕區":"803",
  "高雄市鼓山區":"804","高雄市旗津區":"805","高雄市前鎮區":"806","高雄市三民區":"807",
  "高雄市楠梓區":"811","高雄市小港區":"812","高雄市左營區":"813","高雄市仁武區":"814",
  "高雄市大社區":"815","高雄市岡山區":"820","高雄市路竹區":"821","高雄市阿蓮區":"822",
  "高雄市田寮區":"823","高雄市燕巢區":"824","高雄市橋頭區":"825","高雄市梓官區":"826",
  "高雄市彌陀區":"827","高雄市永安區":"828","高雄市湖內區":"829","高雄市鳳山區":"830",
  "高雄市大寮區":"831","高雄市林園區":"832","高雄市鳥松區":"833","高雄市大樹區":"840",
  "高雄市旗山區":"842","高雄市美濃區":"843","高雄市六龜區":"844","高雄市內門區":"845",
  "高雄市杉林區":"846","高雄市甲仙區":"847","高雄市桃源區":"848","高雄市那瑪夏區":"849",
  "高雄市茂林區":"851","高雄市茄萣區":"852",
  // 屏東縣
  "屏東縣屏東市":"900",
};

// 台灣地址 → 縣市、鄉鎮市區
function parseAddress(addr) {
  const a = addr.replace(/^\d{3,6}/, "").replace(/台/g, "臺").trim();
  const region = (a.match(/^(.{2}[縣市])/) || [])[1] || "";
  const rest = a.slice(region.length);
  // 「新竹縣竹北」這種沒寫「市」的也能抓到「竹北」
  const locality = (rest.match(/^(.{1,3}?[鄉鎮市區])/) || [])[1] || (rest.match(/^([^\d\s路街道段]{2})/) || [])[1] || "";
  // 郵遞區號：優先從地址開頭數字取，否則查對照表
  const postalFromAddr = (addr.match(/^(\d{3,6})/) || [])[1] || "";
  const postalFromTable = TW_POSTAL[region + locality] || TW_POSTAL[region + (locality.replace(/臺/g, "台"))] || "";
  const postal = postalFromAddr || postalFromTable;
  // streetAddress：有街道則用原始地址，否則用區域名稱（確保 Google Rich Results 必填欄位）
  const streetAddress = /[路街道段巷號]/.test(addr) ? addr : (locality || region);
  return {
    "@type": "PostalAddress",
    streetAddress,
    addressLocality: locality || region,
    addressRegion: region,
    ...(postal && { postalCode: postal }),
    addressCountry: "TW",
  };
}

// 縣市 → 地區頁網址代稱
const REGION_SLUGS = {
  "台北市": "taipei", "新北市": "new-taipei", "基隆市": "keelung", "桃園市": "taoyuan",
  "新竹市": "hsinchu-city", "新竹縣": "hsinchu-county", "苗栗縣": "miaoli", "台中市": "taichung",
  "彰化縣": "changhua", "南投縣": "nantou", "雲林縣": "yunlin", "嘉義市": "chiayi-city",
  "嘉義縣": "chiayi-county", "台南市": "tainan", "高雄市": "kaohsiung", "屏東縣": "pingtung",
  "宜蘭縣": "yilan", "花蓮縣": "hualien", "台東縣": "taitung", "澎湖縣": "penghu",
  "金門縣": "kinmen", "連江縣": "lienchiang",
};
const AREA_MIN_JOBS = 3; // 職缺數達到這個數量才提交給 Google（避免內容太少）
const regionOf = (job) => parseAddress(job.address).addressRegion.replace(/臺/g, "台");
const localityOf = (job) => {
  const a = parseAddress(job.address);
  return a.addressLocality !== a.addressRegion ? a.addressLocality.replace(/臺/g, "台") : "";
};

// 「月薪 32,000~38,000」「時薪200」「3.2萬起」「面議」→ baseSalary
function parseSalary(text) {
  if (!text || /面議/.test(text) && !/\d/.test(text)) return null;
  const nums = [...text.replace(/,/g, "").matchAll(/(\d+(?:\.\d+)?)\s*(萬|k|K)?/g)]
    .map((m) => parseFloat(m[1]) * (m[2] === "萬" ? 10000 : m[2] ? 1000 : 1))
    .filter((n) => n >= 100);
  if (!nums.length) return null;
  let unit = /時薪/.test(text) ? "HOUR" : /日薪/.test(text) ? "DAY" : /年薪/.test(text) ? "YEAR" : /月薪/.test(text) ? "MONTH" : "";
  if (!unit) unit = nums[0] < 1000 ? "HOUR" : nums[0] < 5000 ? "DAY" : nums[0] > 200000 ? "YEAR" : "MONTH";
  const value = nums.length >= 2
    ? { "@type": "QuantitativeValue", minValue: Math.min(nums[0], nums[1]), maxValue: Math.max(nums[0], nums[1]), unitText: unit }
    : { "@type": "QuantitativeValue", value: nums[0], unitText: unit };
  return { "@type": "MonetaryAmount", currency: "TWD", value };
}

function employmentType(text = "") {
  if (/兼職|工讀|PT|part/i.test(text)) return "PART_TIME";
  if (/臨時|短期|日領|日結/.test(text)) return "TEMPORARY";
  if (/實習/.test(text)) return "INTERN";
  if (/約聘|契約|承攬/.test(text)) return "CONTRACTOR";
  return "FULL_TIME"; // 正職、派遣預設為全職
}

const nl2br = (s) => esc(s).replace(/\r?\n/g, "<br>");

// 頁尾：母公司
const siteFooter = () => `<footer class="site-foot">
  <p>JOB365 為 <a href="${CONFIG.PARENT.url}" target="_blank" rel="noopener" data-ga="parent_site_click">${CONFIG.PARENT.name}</a> 旗下團隊</p>
</footer>`;
const footerGa = () => CONFIG.GA4_ID ? `<script>document.querySelectorAll(".site-foot a[data-ga]").forEach(function(a){a.addEventListener("click",function(){gtag("event",a.dataset.ga,{source:location.pathname.indexOf("/jobs/")>-1?"job_page":"site"});});});</script>` : "";

// 頁首：左邊 Logo，右邊「職缺地圖」
const topHeader = () => `<header class="top"><a class="brand" href="${CONFIG.SITE_URL}/"><img src="${CONFIG.SITE_URL}/favicon-192.png" alt="JOB365 Logo" width="36" height="36"><span><b>JOB365 CONSULTANT</b><small>${CONFIG.KEYWORD}</small></span></a><nav class="toplinks"><a href="${CONFIG.SITE_URL}/">職缺地圖</a></nav></header>`;
const topCss = `.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px}.top .brand{margin:0}
  .toplinks{display:flex;align-items:center;gap:2px;font-size:.82rem;white-space:nowrap}
  .toplinks a{display:inline-flex;align-items:center;height:30px;padding:0 12px;border:1px solid transparent;border-radius:999px;line-height:1;color:var(--muted);text-decoration:none}
  .toplinks .biz{border-color:var(--line)}
  @media (max-width:420px){.top .brand small{display:none}.toplinks a{padding:0 9px}}`;

// GA4 載入碼（與地圖 index.html 相同寫法）
const gaHead = () => CONFIG.GA4_ID ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${CONFIG.GA4_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","${CONFIG.GA4_ID}");</script>` : "";

// 職缺頁事件：view_job（進入頁面）、contact_click（點立即應徵，與地圖同名）、job_page_to_map（點在地圖上查看）
function gaJobEvents(job) {
  if (!CONFIG.GA4_ID) return "";
  const p = JSON.stringify({
    company: job.industry, job_title: job.title, category: job.category, city: job.address,
    job_id: job.id, source: "job_page",
    items: [{ item_id: job.id, item_name: job.title, item_brand: job.industry, item_category: job.category, item_variant: job.address }],
  }).replace(/</g, "\\u003c");
  return `<script>(function(){var p=${p};gtag("event","view_job",p);
document.querySelector(".apply")&&document.querySelector(".apply").addEventListener("click",function(){gtag("event","contact_click",p);});
document.querySelector(".back")&&document.querySelector(".back").addEventListener("click",function(){gtag("event","job_page_to_map",p);});})();</script>`;
}

// ---------------- 3. 讀取資料 ----------------
// 簡易 CSV 解析（支援引號、逗號、換行）
function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows;
  const keys = header.map((h) => h.replace(/[\u200B-\u200F\uFEFF]/g, "").trim());
  return body
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
}

async function loadRows() {
  if (CONFIG.JOBS_JSON_FILE) return JSON.parse(fs.readFileSync(CONFIG.JOBS_JSON_FILE, "utf8"));
  if (CONFIG.JOBS_API_URL) {
    const res = await fetch(CONFIG.JOBS_API_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`讀取職缺失敗：HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : data.jobs || data.data || [];
  }
  const res = await fetch(CONFIG.SHEET_CSV_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`讀取試算表失敗：HTTP ${res.status}`);
  const text = await res.text();
  if (text.trim().startsWith("<")) throw new Error("試算表回傳 HTML，請確認已設為「知道連結的任何人皆可檢視」");
  return parseCsv(text);
}

// 職缺頁／Google 求職用的職稱：拿掉裝飾符號與表情符號（Google 規範職稱只放職稱本身）
const cleanTitle = (t) => String(t || "")
  .replace(/[\p{Extended_Pictographic}\u2600-\u27BF\u2B00-\u2BFF\u25A0-\u25FF\uFE0F\u200D]/gu, "")
  .replace(/\s{2,}/g, " ").trim() || String(t || "").trim();

// 地圖的單一職缺分享網址（與 index.html 的 jobShareUrl 規則相同）
const mapJobUrl = (job) =>
  `${CONFIG.SITE_URL}/?job=${encodeURIComponent(`${job.industry}_${job.rawTitle ?? job.title}`.replace(/\s+/g, ""))}`;

// ---------------- 4. 產生頁面 ----------------
function buildJsonLd(job) {
  const descHtml = [
    `<p>${esc(job.address)}${job.industry ? esc(job.industry) : ""}徵求「${esc(job.title)}」${job.category ? `（${esc(job.category)}）` : ""}。</p>`,
    job.description && `<p><strong>工作內容</strong><br>${nl2br(job.description)}</p>`,
    job.requirements && `<p><strong>應徵條件</strong><br>${nl2br(job.requirements)}</p>`,
    job.hours && `<p><strong>工作時間</strong><br>${nl2br([job.shift, job.hours].filter(Boolean).join("　"))}</p>`,
    job.restDay && `<p><strong>休假制度</strong><br>${nl2br(job.restDay)}</p>`,
    job.salaryText && `<p><strong>薪資待遇</strong><br>${nl2br(job.salaryText)}</p>`,
    job.benefits && `<p><strong>福利</strong><br>${nl2br(job.benefits)}</p>`,
  ].filter(Boolean).join("");

  const ld = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: descHtml,
    identifier: { "@type": "PropertyValue", name: CONFIG.ORG.name, value: job.id },
    datePosted: job.datePosted,
    validThrough: `${job.validThrough}T23:59:59+08:00`,
    employmentType: job.employmentType,
    hiringOrganization: {
      "@type": "Organization",
      name: job.company || CONFIG.ORG.name,
      sameAs: CONFIG.ORG.url,
      logo: CONFIG.ORG.logo,
      parentOrganization: { "@type": "Organization", name: CONFIG.PARENT.name, url: CONFIG.PARENT.url },
    },
    jobLocation: { "@type": "Place", address: parseAddress(job.address) },
    directApply: false,
  };
  const salary = parseSalary(job.salaryText);
  if (salary) ld.baseSalary = salary;
  // 避免 </script> 提早結束
  return JSON.stringify(ld, null, 2).replace(/</g, "\\u003c");
}

function pageHtml(job, { closed }) {
  const url = `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/${job.id}.html`;
  const loc = parseAddress(job.address);
  const area = [loc.addressRegion, loc.addressLocality !== loc.addressRegion ? loc.addressLocality : ""].join("");
  // 標題：職稱｜地區（簡稱）｜薪資 - JOB365，例如「堆高機人員｜桃園蘆竹｜月薪36,000起 - JOB365」
  const regionShort = loc.addressRegion.replace(/[縣市]$/, "");
  const localityShort = loc.addressLocality !== loc.addressRegion ? (loc.addressLocality.length > 2 ? loc.addressLocality.replace(/[區鄉鎮市]$/, "") : loc.addressLocality) : "";
  // 鄉鎮名和縣市同名（桃園市桃園區、苗栗縣苗栗市）時，只寫「桃園區」「苗栗市」，避免「桃園桃園」
  const shortArea = (localityShort && localityShort === regionShort
    ? loc.addressLocality
    : [regionShort, localityShort].join("")).replace(/臺/g, "台") || job.address;
  const salaryShort = job.salaryText && !/^面議$/.test(job.salaryText) ? job.salaryText.slice(0, 20) : "";
  const pageTitle = [job.title, shortArea, salaryShort].filter(Boolean).join("｜") + " - JOB365";
  const summary = [job.salaryText === "面議" ? "薪資面議" : job.salaryText, [job.shift, job.hours].filter(Boolean).join(" "), job.restDay].filter(Boolean).join("，");
  const metaDesc = `${area}${job.title}${summary ? "，" + summary : ""}。${(job.description || "").replace(/\s+/g, " ").slice(0, 60)}${job.description ? "。" : ""}JOB365 ${CONFIG.KEYWORD}，免費應徵。`;
  const section = (h, v) => (v ? `<section><h2>${h}</h2><p>${nl2br(v)}</p></section>` : "");

  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="${CONFIG.SITE_URL}/favicon.png">
<meta property="og:title" content="${esc(pageTitle)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:image" content="${CONFIG.SITE_URL}/og-image.png">
<meta property="og:url" content="${url}">
${closed ? '<meta name="robots" content="noindex">' : `<script type="application/ld+json">\n${buildJsonLd(job)}\n</script>`}
${gaHead()}
<style>
  :root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#5b6475;--brand:#e8590c;--line:#e3e6eb}
  @media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--ink:#e9ecf1;--muted:#a3abb9;--line:#2e333c}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
  main{max-width:720px;margin:0 auto;padding:24px 16px 96px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}
  h1{font-size:1.5rem;margin:0 0 4px;line-height:1.35}.meta{color:var(--muted);margin:0 0 16px}
  .tags span{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 12px;margin:0 6px 6px 0;font-size:.9rem}
  h2{font-size:1.05rem;margin:24px 0 4px}section p{margin:0}
  .closed{background:#fff3cd;color:#664d03;border-radius:10px;padding:12px 16px;margin-bottom:16px}
  .cta{position:fixed;left:0;right:0;bottom:0;padding:12px 16px;background:var(--card);border-top:1px solid var(--line);display:flex;gap:12px;justify-content:center}
  .cta a{flex:1;max-width:340px;text-align:center;padding:12px;border-radius:10px;text-decoration:none;font-weight:600}
  .apply{background:var(--brand);color:#fff}.back{border:1px solid var(--line);color:var(--ink)}
  .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);margin:0 0 16px}
  .brand img{width:36px;height:36px;border-radius:9px}
  .brand b{display:block;font-size:.95rem;letter-spacing:.08em;line-height:1.2}
  .brand small{display:block;color:var(--muted);font-size:.8rem;line-height:1.3}
  .crumbs{font-size:.82rem;color:var(--muted);margin:0 0 12px}.crumbs a{color:var(--muted)}
  ${topCss}
  .site-foot{margin:28px 0 0;text-align:center;font-size:.82rem;color:var(--muted)}
  .site-foot p{margin:4px 0}.site-foot a{color:var(--muted);text-decoration:underline}
</style>
</head>
<body>
<main>
  ${topHeader()}
  <nav class="crumbs"><a href="${CONFIG.SITE_URL}/">職缺地圖</a> › ${REGION_SLUGS[regionOf(job)] ? `<a href="area/${REGION_SLUGS[regionOf(job)]}.html">${esc(regionOf(job))}職缺</a> › ` : ""}${esc(job.title)}</nav>
  <article class="card">
    ${closed ? '<div class="closed">此職缺已停止招募，歡迎回到職缺地圖查看其他職缺。</div>' : ""}
    <h1>${esc(job.title)}</h1>
    <p class="meta">${esc(job.company || CONFIG.ORG.name)}　·　${esc(job.address)}</p>
    <div class="tags">
      ${job.salaryText ? `<span>${esc(job.salaryText)}</span>` : ""}
      ${job.industry ? `<span>${esc(job.industry)}</span>` : ""}
      ${job.category ? `<span>${esc(job.category)}</span>` : ""}
      ${job.shift ? `<span>${esc(job.shift)}</span>` : ""}
      ${area ? `<span>${esc(area)}</span>` : ""}
    </div>
    ${section("工作內容", job.description)}
    ${section("應徵條件", job.requirements)}
    ${section("工作時間", [job.shift, job.hours].filter(Boolean).join("　"))}
    ${section("休假制度", job.restDay)}
    ${section("薪資待遇", job.salaryText)}
    ${section("福利", job.benefits)}
  </article>
  ${siteFooter()}
</main>
<nav class="cta">
  <a class="back" href="${closed ? `${CONFIG.SITE_URL}/` : esc(mapJobUrl(job))}">${closed ? "看更多職缺" : "在地圖上查看"}</a>
  ${closed ? "" : `<a class="apply" href="${esc(job.link || CONFIG.APPLY_URL)}" target="_blank" rel="noopener">立即應徵</a>`}
</nav>
${gaJobEvents(job)}
${footerGa()}
</body>
</html>
`;
}

// 地區頁：給求職者的職缺列表
function areaHtml(region, slug, jobs, areaLinks) {
  const url = `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/area/${slug}.html`;
  const n = jobs.length;
  // 「竹北」「竹北市」視為同一區，顯示名稱用比較完整的寫法
  const groups = {};
  for (const j of jobs) {
    const name = localityOf(j) || "其他地區";
    const key = name.length > 2 ? name.replace(/[市鄉鎮區]$/, "") : name;
    const g = (groups[key] ||= { name, list: [] });
    if (name.length > g.name.length) g.name = name;
    g.list.push(j);
  }
  const locs = Object.values(groups).map((g) => [g.name, g.list]).sort((a, b) => b[1].length - a[1].length);
  const inds = Object.entries(jobs.reduce((m, j) => { if (j.industry) m[j.industry] = (m[j.industry] || 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const locNames = locs.map(([k]) => k).filter((k) => k !== "其他地區");
  const title = `${region}正職職缺 ${n} 筆｜JOB365 職缺地圖`;
  const desc = n
    ? `${region}目前有 ${n} 筆招募中正職職缺${locNames.length ? `，分布在${locNames.slice(0, 4).join("、")}等地` : ""}${inds.length ? `，產業以${inds.slice(0, 3).join("、")}為主` : ""}。`
    : `${region}目前暫無招募中職缺，歡迎查看其他地區職缺。`;
  const jobLi = (j) => `<li><a href="../${j.id}.html">${esc(j.title)}</a><small>${esc([j.salaryText, j.shift, j.industry].filter(Boolean).join("｜"))}</small></li>`;
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "職缺地圖", item: `${CONFIG.SITE_URL}/` },
        { "@type": "ListItem", position: 2, name: "全部職缺", item: `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/` },
        { "@type": "ListItem", position: 3, name: `${region}職缺`, item: url } ] },
      { "@type": "ItemList", name: `${region}正職職缺`, numberOfItems: n,
        itemListElement: jobs.slice(0, 100).map((j, i) => ({ "@type": "ListItem", position: i + 1, url: `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/${j.id}.html` })) },
    ],
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<link rel="icon" href="${CONFIG.SITE_URL}/favicon.png">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${CONFIG.SITE_URL}/og-image.png">
${n < AREA_MIN_JOBS ? '<meta name="robots" content="noindex">' : ""}
<script type="application/ld+json">${ld}</script>
${gaHead()}
<style>
  :root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#5b6475;--brand:#e8590c;--line:#e3e6eb;--soft:#fff1e9}
  @media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--ink:#e9ecf1;--muted:#a3abb9;--line:#2e333c;--soft:#2a211b}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
  main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
  .brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink);margin:0 0 14px}
  .brand img{width:36px;height:36px;border-radius:9px}.brand b{display:block;font-size:.95rem;letter-spacing:.08em;line-height:1.2}.brand small{display:block;color:var(--muted);font-size:.8rem;line-height:1.3}
  .crumbs{font-size:.82rem;color:var(--muted);margin:0 0 8px}.crumbs a{color:var(--muted)}
  ${topCss}
  h1{font-size:1.7rem;line-height:1.35;margin:0 0 8px}
  .lead{color:var(--muted);margin:0 0 18px}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 22px}
  .chips a,.chips span{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:4px 12px;font-size:.88rem;text-decoration:none;color:var(--ink)}
  .chips b{color:var(--brand);margin-left:4px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:0 0 14px}
  h2{font-size:1.1rem;margin:0 0 8px}
  ul.jobs{list-style:none;margin:0;padding:0}
  ul.jobs li{padding:9px 0;border-top:1px dashed var(--line)}ul.jobs li:first-child{border-top:0}
  ul.jobs a{color:var(--ink);font-weight:600}ul.jobs small{display:block;color:var(--muted);font-size:.85rem}
  .hire{background:var(--soft);border:1px solid #ffd9c4;border-radius:16px;padding:20px;margin:26px 0 14px}
  .hire h2{font-size:1.2rem}.hire p{margin:0 0 12px;color:var(--muted)}
  .btns{display:flex;flex-wrap:wrap;gap:10px}
  .btns a{padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700}
  .b1{background:var(--brand);color:#fff}.b2{background:#06c755;color:#fff}
  .others a{color:var(--muted)}
  .site-foot{margin:28px 0 0;text-align:center;font-size:.82rem;color:var(--muted)}.site-foot p{margin:4px 0}.site-foot a{color:var(--muted)}
</style>
</head>
<body>
<main>
  ${topHeader()}
  <nav class="crumbs"><a href="${CONFIG.SITE_URL}/">職缺地圖</a> › <a href="../">全部職缺</a> › ${esc(region)}職缺</nav>
  <h1>${esc(region)}正職職缺（${n}）</h1>
  <p class="lead">${esc(desc.split("。")[0])}。資料每日更新。</p>
  ${locs.length > 1 ? `<div class="chips">${locs.map(([k, v], i) => `<a href="#loc-${i}">${esc(k)}<b>${v.length}</b></a>`).join("")}</div>` : ""}
  ${locs.map(([k, v], i) => `<section class="card" id="loc-${i}"><h2>${esc(k)}職缺（${v.length}）</h2><ul class="jobs">${v.map(jobLi).join("")}</ul></section>`).join("\n  ")}
  ${n ? "" : `<section class="card"><p>目前暫無招募中職缺，<a href="${CONFIG.SITE_URL}/">到職缺地圖看其他地區 →</a></p></section>`}


  ${areaLinks.length > 1 ? `<p class="others">其他地區：${areaLinks.filter((a) => a.slug !== slug).map((a) => `<a href="${a.slug}.html">${esc(a.name)}職缺</a>`).join("・")}</p>` : ""}
  ${siteFooter()}
</main>
${CONFIG.GA4_ID ? `<script>document.querySelectorAll("a[data-ga]").forEach(function(a){a.addEventListener("click",function(){gtag("event",a.dataset.ga,{source:"area",region:${JSON.stringify(region)}});});});</script>` : ""}
</body>
</html>
`;
}

function indexHtml(jobs, areaLinks = []) {
  const items = jobs
    .map((j) => `<li><a href="${j.id}.html">${esc(j.title)}</a>　<small>${esc(parseAddress(j.address).addressRegion)}　${esc(j.salaryText)}</small></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>全部職缺｜JOB365 ${CONFIG.KEYWORD}</title>
<meta name="description" content="JOB365 ${CONFIG.KEYWORD}職缺總覽，共 ${jobs.length} 筆招募中職缺，可依地區、薪資、班別快速找到適合的工作。">
<link rel="icon" href="${CONFIG.SITE_URL}/favicon.png">
<link rel="canonical" href="${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/">
${gaHead()}
<style>body{margin:0;background:#f6f7f9;color:#1d2330;font:16px/1.8 -apple-system,"PingFang TC","Noto Sans TC",sans-serif}main{max-width:720px;margin:0 auto;padding:24px 16px}a{color:#c2410c}small{color:#5b6475}
@media (prefers-color-scheme:dark){body{background:#14171c;color:#e9ecf1}a{color:#fb923c}small{color:#a3abb9}}</style>
</head><body><main><a href="../" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit"><img src="../favicon-192.png" alt="JOB365 Logo" width="36" height="36" style="border-radius:9px"><b style="letter-spacing:.08em">JOB365 CONSULTANT</b></a><h1>全部職缺（${jobs.length}）</h1><p><a href="../">← 回職缺地圖</a></p>${areaLinks.length ? `<p>依地區瀏覽：${areaLinks.map((a) => `<a href="area/${a.slug}.html">${esc(a.name)}（${a.n}）</a>`).join("・")}</p>` : ""}<ul>
${items}
</ul>
<div style="color:#5b6475;font-size:.85rem;margin-top:32px">${siteFooter().replace('class="site-foot"', 'class="site-foot" style="text-align:left"')}</div>
</main>${footerGa()}</body></html>
`;
}

function sitemapXml(jobs, areaLinks = []) {
  const urls = [
    { loc: `${CONFIG.SITE_URL}/`, lastmod: today() },
    { loc: `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/`, lastmod: today() },
    ...areaLinks.map((a) => ({ loc: `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/area/${a.slug}.html`, lastmod: today() })),
    ...jobs.map((j) => ({ loc: `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/${j.id}.html`, lastmod: j.datePosted })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
}

// ---------------- 5. 主流程 ----------------
async function main() {
  const rows = await loadRows();
  const outDir = path.join(ROOT, CONFIG.OUT_DIR);
  fs.mkdirSync(outDir, { recursive: true });
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};

  const hasStatusCol = rows.some((r) => pick(r, "status"));
  if (!hasStatusCol) console.warn("⚠ 找不到「狀態」欄位：所有職缺都會被視為招募中。建議在試算表新增「狀態」欄。");

  const open = [];
  const posted = []; // 每筆職缺（含已停招）的刊登日期，用來算「近 30 天新增」
  const seen = new Set();
  const warnings = [];

  for (const row of rows) {
    const job = {
      id: jobId(row),
      title: cleanTitle(pick(row, "title")),
      rawTitle: pick(row, "title"), // 地圖分享網址要用原始職稱比對
      company: pick(row, "company"),
      address: pick(row, "address"),
      industry: pick(row, "industry"),
      category: pick(row, "category"),
      salaryText: pick(row, "salary"),
      description: pick(row, "description"),
      requirements: pick(row, "requirements"),
      hours: pick(row, "hours"),
      shift: pick(row, "shift"),
      restDay: pick(row, "restDay"),
      benefits: pick(row, "benefits"),
      link: /^https?:\/\//.test(pick(row, "link")) ? pick(row, "link") : "",
    };
    if (!job.title || !job.address) { warnings.push(`略過（缺職稱或地址）：${JSON.stringify(row).slice(0, 80)}`); continue; }
    if (seen.has(job.id)) { warnings.push(`重複的職缺 ID：${job.id}`); continue; }
    seen.add(job.id);

    const st = state[job.id] || { firstSeen: today() };
    job.datePosted = toDate(pick(row, "posted")) || st.firstSeen;
    posted.push(job.datePosted);
    // 有填截止日期就用；沒填的話，只要狀態是招募中，每次執行都往後延，避免被判定過期
    const explicitEnd = toDate(pick(row, "validThrough"));
    job.validThrough = explicitEnd || addDays(today(), CONFIG.DEFAULT_VALID_DAYS);
    job.employmentType = employmentType([job.title, job.category, job.salaryText].join(" "));

    const statusText = pick(row, "status").toLowerCase();
    const closed = CONFIG.CLOSED_WORDS.some((w) => statusText.includes(w)) || Boolean(explicitEnd && explicitEnd < today());

    fs.writeFileSync(path.join(outDir, `${job.id}.html`), pageHtml(job, { closed }));
    state[job.id] = { ...st, lastSeen: today(), closed, title: job.title };
    if (!closed) open.push(job);
  }

  // 試算表中已刪除的職缺：保留網址，但改成「已停止招募」頁
  for (const [id, st] of Object.entries(state)) {
    if (seen.has(id) || st.closed) continue;
    const file = path.join(outDir, `${id}.html`);
    if (fs.existsSync(file)) {
      let html = fs.readFileSync(file, "utf8")
        .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '<meta name="robots" content="noindex">')
        .replace(/<a class="apply"[^>]*>.*?<\/a>/, "")
        .replace('<article class="card">', '<article class="card">\n    <div class="closed">此職缺已停止招募，歡迎回到職缺地圖查看其他職缺。</div>');
      fs.writeFileSync(file, html);
    }
    state[id] = { ...st, closed: true };
  }

  // 地區頁
  const areaDir = path.join(outDir, "area");
  fs.mkdirSync(areaDir, { recursive: true });
  const byRegion = {};
  for (const j of open) { const r = regionOf(j); if (REGION_SLUGS[r]) (byRegion[r] ||= []).push(j); }
  const areaLinks = Object.entries(byRegion).filter(([, v]) => v.length >= AREA_MIN_JOBS)
    .sort((a, b) => b[1].length - a[1].length).map(([name, v]) => ({ name, slug: REGION_SLUGS[name], n: v.length }));
  const slugToRegion = Object.fromEntries(Object.entries(REGION_SLUGS).map(([k, v]) => [v, k]));
  const existing = fs.readdirSync(areaDir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5));
  for (const slug of new Set([...Object.keys(byRegion).map((r) => REGION_SLUGS[r]), ...existing])) {
    const region = slugToRegion[slug];
    if (!region) continue;
    fs.writeFileSync(path.join(areaDir, `${slug}.html`), areaHtml(region, slug, byRegion[region] || [], areaLinks));
  }

  fs.writeFileSync(path.join(outDir, "index.html"), indexHtml(open, areaLinks));

  // 給代招頁 /hire/ 顯示的統計數字（每次更新自動重算）
  const tally = (list) => Object.entries(list.reduce((m, k) => { if (k) m[k] = (m[k] || 0) + 1; return m; }, {}))
    .sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify({
    updated: today(),
    open: open.length,
    new30: posted.filter((d) => d && d >= addDays(today(), -30)).length,
    // 每月「累計」合作職缺數（含已停招），呈現成長趨勢
    monthly: (() => { let sum = 0; return Object.entries(posted.reduce((m, d) => { if (d) m[d.slice(0, 7)] = (m[d.slice(0, 7)] || 0) + 1; return m; }, {}))
      .sort((a, b) => a[0].localeCompare(b[0])).map(([month, n]) => ({ month, n: (sum += n) })).slice(-6); })(),
    industries: tally(open.map((j) => j.industry)),
    regions: tally(open.map(regionOf)).map((r) => {
      const inR = open.filter((j) => regionOf(j) === r.name);
      return { ...r, url: areaLinks.some((a) => a.name === r.name) ? `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/area/${REGION_SLUGS[r.name]}.html` : "",
        // 給 /hire/ 地區頁顯示：該地區主要產業與最新職缺
        industries: tally(inR.map((j) => j.industry)).slice(0, 5),
        latest: [...inR].sort((x, y) => (y.datePosted || "").localeCompare(x.datePosted || "") || y.id.localeCompare(x.id)).slice(0, 3)
          .map((j) => ({ title: j.title, area: localityOf(j), url: `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/${j.id}.html` })) };
    }),
    categories: tally(open.map((j) => j.category)),
    // 首頁「最新職缺」卡片用
    latest: [...open].sort((a, b) => (b.datePosted || "").localeCompare(a.datePosted || "") || b.id.localeCompare(a.id)).slice(0, 12)
      .map((j) => ({ id: j.id, title: j.title, region: regionOf(j), area: localityOf(j), salary: j.salaryText, shift: j.shift, url: `${CONFIG.SITE_URL}/${CONFIG.OUT_DIR}/${j.id}.html` })),
  }, null, 2));
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), sitemapXml(open, areaLinks));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  warnings.forEach((w) => console.warn("⚠ " + w));
  console.log(`✔ 完成：招募中 ${open.length} 筆，停止招募 ${Object.values(state).filter((s) => s.closed).length} 筆`);
}

main().catch((e) => { console.error("✖ " + e.message); process.exit(1); });
