import { useState, useRef, useEffect } from "react";
import Papa from "papaparse";

// --- Claude Artifact 専用の window.storage を、ブラウザの localStorage で代替 ---
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    async get(key) {
      const v = localStorage.getItem(key);
      if (v === null) throw new Error("not found");
      return { key, value: v };
    },
    async set(key, value) {
      localStorage.setItem(key, value);
      return { key, value };
    },
    async delete(key) {
      localStorage.removeItem(key);
      return { key, deleted: true };
    },
    async list(prefix) {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (!prefix || k.startsWith(prefix))) keys.push(k);
      }
      return { keys };
    },
  };
}

const PALETTE = {
  field: "#0F3D2E",
  fieldDark: "#0A2920",
  fieldLine: "#1C5A43",
  paper: "#F2E9D8",
  paperDark: "#E6D9BE",
  ink: "#211D16",
  gold: "#C9A227",
  goldBright: "#E0BB3F",
  crimson: "#A83232",
  slate: "#5B6B63",
};

const MONO = '"SFMono-Regular", "Roboto Mono", ui-monospace, Menlo, monospace';
const SANS = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic", system-ui, sans-serif';

const TRIALS = 20000;
const RUN_DURATION = 1400;
const HORSE_EMOJI = "🐎";

const RUNNING_STYLES = ["逃げ", "先行", "差し", "追込"];

const FACTOR_DEFS = [
  { key: "conditionFit", label: "馬場適性", weight: 5 },
  { key: "courseFit", label: "コース・距離適性", weight: 6 },
  { key: "training", label: "追い切り", weight: 5 },
  { key: "jockeyFit", label: "騎手実績", weight: 4 },
  { key: "paceFit", label: "展開適性", weight: 5 },
];

const RATING_OPTIONS = [
  { level: -2, icon: "×" },
  { level: -1, icon: "▲" },
  { level: 0, icon: "△" },
  { level: 1, icon: "○" },
  { level: 2, icon: "◎" },
];

const VARIANCE_PRESETS = [
  { label: "堅め", desc: "力量差が明確・少頭数", value: 0.6 },
  { label: "標準", desc: "通常のレース", value: 1.1 },
  { label: "混戦", desc: "僅差・多頭数", value: 1.6 },
  { label: "大荒れ想定", desc: "道悪・波乱含み", value: 2.2 },
];

const WEATHER_OPTIONS = ["晴", "曇", "雨", "雪"];
const TRACK_OPTIONS = ["良", "稍重", "重", "不良"];
const BIAS_OPTIONS = ["フラット", "内有利", "外有利", "日替わり(不安定)"];

function makeHorse(id, name, overrides = {}) {
  return {
    id,
    name,
    runningStyle: "先行",
    weight: 55,
    conditionFit: 0,
    courseFit: 0,
    training: 0,
    jockeyFit: 0,
    paceFit: 0,
    manualAbility: null,
    ...overrides,
  };
}

const DEFAULT_HORSES = [
  makeHorse(1, "サクラハヤブサ", { runningStyle: "逃げ", weight: 54, conditionFit: 2, courseFit: 2, training: 1, jockeyFit: 1, paceFit: 1 }),
  makeHorse(2, "カブトブレイズ", { runningStyle: "先行", weight: 56, conditionFit: 1, courseFit: 1, training: 1, jockeyFit: 0, paceFit: 0 }),
  makeHorse(3, "ゴールデンウィスプ", { runningStyle: "差し", weight: 55, conditionFit: 0, courseFit: 0, training: 0, jockeyFit: 0, paceFit: 0 }),
  makeHorse(4, "シルバーラプター", { runningStyle: "先行", weight: 57, conditionFit: 0, courseFit: -1, training: 0, jockeyFit: 0, paceFit: -1 }),
  makeHorse(5, "レッドインパルス", { runningStyle: "差し", weight: 58, conditionFit: -1, courseFit: -1, training: -1, jockeyFit: 0, paceFit: 0 }),
  makeHorse(6, "ブルーメテオ", { runningStyle: "追込", weight: 59, conditionFit: -1, courseFit: -2, training: -1, jockeyFit: -1, paceFit: -1 }),
];

function gumbel() {
  const u = Math.max(Math.random(), 1e-9);
  return -Math.log(-Math.log(u));
}

function computeBiasFit(style, bias) {
  const inside = ["逃げ", "先行"];
  const outside = ["差し", "追込"];
  if (bias === "内有利") return inside.includes(style) ? 1 : outside.includes(style) ? -1 : 0;
  if (bias === "外有利") return outside.includes(style) ? 1 : inside.includes(style) ? -1 : 0;
  return 0;
}

function computeHorseAbility(horse, allHorses, bias) {
  if (horse.manualAbility !== null && horse.manualAbility !== undefined) {
    return Math.max(1, Math.min(100, Math.round(Number(horse.manualAbility))));
  }
  const avgWeight =
    allHorses.reduce((s, h) => s + (Number(h.weight) || 55), 0) / allHorses.length;
  const weightAdj = Math.max(
    -8,
    Math.min(8, (avgWeight - (Number(horse.weight) || 55)) * 1.2)
  );
  const biasAdj = computeBiasFit(horse.runningStyle, bias) * 4;
  let raw = 50 + weightAdj + biasAdj;
  FACTOR_DEFS.forEach((f) => {
    raw += (horse[f.key] || 0) * f.weight;
  });
  return Math.max(1, Math.min(100, Math.round(raw)));
}

function clampRating(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(-2, Math.min(2, n)) : 0;
}

function extractText(content) {
  return (content || []).map((block) => block.text || "").join("\n");
}

function jockeyCacheKey(venue, surface, jockeyName) {
  return `jockey-rating:${venue || "-"}|${surface || "-"}|${jockeyName}`;
}

async function getCachedJockeyRating(jockeyName, venue, surface) {
  const key = jockeyCacheKey(venue, surface, jockeyName);
  try {
    const result = await window.storage.get(key, false);
    if (result && result.value) {
      const data = JSON.parse(result.value);
      const ageDays = (Date.now() - new Date(data.updatedAt).getTime()) / 86400000;
      if (ageDays < 180) return data.rating;
    }
  } catch (e) {
    // キャッシュなし
  }
  return null;
}

async function setCachedJockeyRating(jockeyName, venue, surface, rating, note) {
  const key = jockeyCacheKey(venue, surface, jockeyName);
  try {
    await window.storage.set(
      key,
      JSON.stringify({ rating, note: note || "", updatedAt: new Date().toISOString() }),
      false
    );
  } catch (e) {
    // 保存失敗は無視(次回また調べるだけ)
  }
}

function computeFactorVariance(factors, horseCount) {
  const trackAdj = { 良: -0.2, 稍重: 0.0, 重: 0.3, 不良: 0.6 };
  const weatherAdj = { 晴: 0, 曇: 0, 雨: 0.15, 雪: 0.2 };
  const biasAdj = { フラット: 0, 内有利: -0.1, 外有利: -0.1, "日替わり(不安定)": 0.3 };
  const fieldAdj = Math.round((horseCount - 8) * 0.05 * 100) / 100;

  const breakdown = [
    { label: "基準値", value: 1.0 },
    { label: `馬場状態(${factors.track})`, value: trackAdj[factors.track] ?? 0 },
    { label: `天候(${factors.weather})`, value: weatherAdj[factors.weather] ?? 0 },
    { label: `トラックバイアス(${factors.bias})`, value: biasAdj[factors.bias] ?? 0 },
    { label: `出走頭数(${horseCount}頭)`, value: fieldAdj },
  ];
  const rawTotal = breakdown.reduce((sum, b) => sum + b.value, 0);
  const total = Math.max(0.3, Math.min(2.5, rawTotal));
  return { breakdown, total };
}

function runSimulation(abilityHorses, variance) {
  const n = abilityHorses.length;
  const win = new Array(n).fill(0);
  const place = new Array(n).fill(0);
  const show = new Array(n).fill(0);
  const logAbility = abilityHorses.map((h) => Math.log(Math.max(h.ability, 1)));

  for (let t = 0; t < TRIALS; t++) {
    const scores = new Array(n);
    for (let i = 0; i < n; i++) {
      scores[i] = logAbility[i] + variance * gumbel();
    }
    const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
    win[order[0]]++;
    place[order[0]]++;
    if (n > 1) place[order[1]]++;
    show[order[0]]++;
    if (n > 1) show[order[1]]++;
    if (n > 2) show[order[2]]++;
  }

  return abilityHorses
    .map((h, i) => ({
      ...h,
      winRate: (win[i] / TRIALS) * 100,
      placeRate: (place[i] / TRIALS) * 100,
      showRate: (show[i] / TRIALS) * 100,
    }))
    .sort((a, b) => b.winRate - a.winRate);
}

function Bar({ label, value, color, delay }) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWidth(value), 60 + delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs w-14 shrink-0" style={{ color: PALETTE.paperDark, fontFamily: SANS }}>
        {label}
      </span>
      <div className="flex-1 h-3 rounded-sm overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
        <div
          className="h-full rounded-sm"
          style={{ width: `${width}%`, background: color, transition: "width 0.9s cubic-bezier(0.16, 1, 0.3, 1)" }}
        />
      </div>
      <span className="text-sm w-16 text-right tabular-nums shrink-0" style={{ color: PALETTE.gold, fontFamily: MONO, fontWeight: 600 }}>
        {value.toFixed(1)}%
      </span>
    </div>
  );
}

function RaceTrack({ horses, progress }) {
  return (
    <div className="space-y-2.5 mb-1">
      {horses.map((h, i) => (
        <div key={h.id} className="relative">
          <div
            className="relative h-7 rounded-sm overflow-hidden"
            style={{
              background: `repeating-linear-gradient(90deg, ${PALETTE.fieldLine} 0px, ${PALETTE.fieldLine} 1px, transparent 1px, transparent 34px)`,
            }}
          >
            <div className="absolute top-0 bottom-0" style={{ left: "92%", width: "2px", background: PALETTE.gold }} />
            <div
              className="absolute top-1/2 text-base"
              style={{ left: `${Math.min(progress[i] ?? 0, 94)}%`, transform: "translate(-50%, -50%)", transition: "left 90ms linear" }}
            >
              {HORSE_EMOJI}
            </div>
          </div>
          <span className="absolute text-xs" style={{ left: 4, top: -14, color: PALETTE.paperDark, fontFamily: SANS }}>
            {i + 1}. {h.name}
          </span>
        </div>
      ))}
      <div className="text-xs text-right pr-1" style={{ color: PALETTE.gold, fontFamily: SANS }}>
        GOAL
      </div>
    </div>
  );
}

function RatingPicker({ label, value, onChange }) {
  return (
    <div>
      <div className="text-xs mb-1" style={{ color: PALETTE.ink }}>
        {label}
      </div>
      <div className="flex gap-1">
        {RATING_OPTIONS.map((o) => (
          <button
            key={o.level}
            onClick={() => onChange(o.level)}
            className="w-7 h-7 rounded-sm text-xs shrink-0"
            style={{
              background: value === o.level ? PALETTE.field : PALETTE.paper,
              color: value === o.level ? PALETTE.paper : PALETTE.ink,
              border: `1px solid ${PALETTE.paperDark}`,
              fontWeight: 700,
            }}
          >
            {o.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

function PredictionRow({ prediction, onRecord, onDelete }) {
  const [selected, setSelected] = useState(prediction.horses[0]?.name || "");
  const topPick = prediction.horses[0];
  const savedDate = prediction.savedAt ? prediction.savedAt.slice(0, 10) : "";

  return (
    <div className="rounded-sm p-2.5" style={{ background: PALETTE.paperDark }}>
      <div className="flex items-center justify-between mb-1 gap-2">
        <span className="text-xs font-bold" style={{ color: PALETTE.ink }}>
          {prediction.raceLabel}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs" style={{ color: PALETTE.slate }}>
            {savedDate}
          </span>
          <button onClick={() => onDelete(prediction.id)} className="text-xs" style={{ color: PALETTE.crimson }}>
            削除
          </button>
        </div>
      </div>
      <div className="text-xs mb-1.5" style={{ color: PALETTE.slate }}>
        本命: {topPick?.name}(勝率{topPick ? topPick.winRate.toFixed(1) : "-"}%)
      </div>

      {prediction.actualResult ? (
        <div className="text-xs flex items-center gap-2 flex-wrap" style={{ color: PALETTE.ink }}>
          <span>実際の1着: {prediction.actualResult.winName}</span>
          <span style={{ fontWeight: 700 }}>
            {prediction.actualResult.hitWin
              ? "🎯 単勝的中"
              : prediction.actualResult.hitShow
              ? "△ 複勝圏内"
              : "❌ 不的中"}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="text-xs p-1 rounded-sm flex-1"
            style={{ background: PALETTE.paper, color: PALETTE.ink, border: "none" }}
          >
            {prediction.horses.map((h) => (
              <option key={h.name} value={h.name}>
                {h.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => onRecord(prediction.id, selected)}
            className="text-xs px-2 py-1 rounded-sm shrink-0"
            style={{ background: PALETTE.field, color: PALETTE.paper, fontWeight: 700 }}
          >
            結果を記録
          </button>
        </div>
      )}
    </div>
  );
}

export default function KeibaSimulator() {
  const [horses, setHorses] = useState(DEFAULT_HORSES);
  const [variance, setVariance] = useState(1.1);
  const [results, setResults] = useState(null);
  const [running, setRunning] = useState(false);
  const [counter, setCounter] = useState(0);
  const [progress, setProgress] = useState([]);
  const [importError, setImportError] = useState("");
  const [imageImporting, setImageImporting] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inputMode, setInputMode] = useState("preset");
  const [raceFactors, setRaceFactors] = useState({ weather: "晴", track: "良", bias: "フラット" });
  const [raceInfo, setRaceInfo] = useState({ venue: "", distance: "", surface: "芝" });
  const [useJockeySearch, setUseJockeySearch] = useState(true);
  const [imageStage, setImageStage] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [showApiKeySettings, setShowApiKeySettings] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [raceLabel, setRaceLabel] = useState("");
  const [savedPredictions, setSavedPredictions] = useState([]);
  const [predictionsLoading, setPredictionsLoading] = useState(true);
  const [savingPrediction, setSavingPrediction] = useState(false);
  const [expandedIds, setExpandedIds] = useState({});
  const rafRef = useRef(null);
  const fileInputRef = useRef(null);
  const imageInputRef = useRef(null);

  const computedHorses = horses.map((h) => ({
    ...h,
    ability: computeHorseAbility(h, horses, raceFactors.bias),
  }));

  const updateHorse = (id, field, value) => {
    setHorses((hs) => hs.map((h) => (h.id === id ? { ...h, [field]: value } : h)));
  };

  const setFactor = (id, key, value) => {
    setHorses((hs) => hs.map((h) => (h.id === id ? { ...h, [key]: value, manualAbility: null } : h)));
  };

  const toggleManualAbility = (id, currentComputed) => {
    setHorses((hs) =>
      hs.map((h) =>
        h.id === id
          ? { ...h, manualAbility: h.manualAbility === null ? currentComputed : null }
          : h
      )
    );
  };

  const toggleExpand = (id) => {
    setExpandedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const addHorse = () => {
    if (horses.length >= 18) return;
    const nextId = Math.max(...horses.map((h) => h.id)) + 1;
    const names = ["ナイトウィザード", "ホワイトジャベリン", "クリムゾンダッシュ", "エメラルドスプリント"];
    setHorses((hs) => [...hs, makeHorse(nextId, names[nextId % names.length] || `新馬${nextId}`)]);
  };

  const removeHorse = (id) => {
    if (horses.length <= 3) return;
    setHorses((hs) => hs.filter((h) => h.id !== id));
  };

  const handleCSVButtonClick = () => {
    setImportError("");
    fileInputRef.current && fileInputRef.current.click();
  };

  const handleCSVUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      Papa.parse(String(ev.target.result), {
        skipEmptyLines: true,
        complete: (result) => {
          try {
            let rows = result.data;
            const secondColNum = parseFloat(rows[0] && rows[0][1]);
            if (rows.length && Number.isNaN(secondColNum)) {
              rows = rows.slice(1);
            }
            const parsed = rows
              .filter((r) => r && r.length >= 2 && String(r[0]).trim() !== "")
              .slice(0, 18)
              .map((r, i) => {
                const ability = Math.round(parseFloat(r[1]));
                return makeHorse(i + 1, String(r[0]).trim(), {
                  manualAbility: Number.isFinite(ability) ? Math.min(100, Math.max(1, ability)) : 50,
                });
              });
            if (parsed.length < 3) {
              setImportError("3頭以上のデータが必要です(形式: 馬名,能力値)");
              return;
            }
            setHorses(parsed);
            setResults(null);
            setImportError("");
          } catch (err) {
            setImportError("CSVの読み込みに失敗しました。形式をご確認ください。");
          }
        },
      });
    };
    reader.readAsText(file, "UTF-8");
    e.target.value = "";
  };

  const handleImageButtonClick = () => {
    setImportError("");
    imageInputRef.current && imageInputRef.current.click();
  };

  const handleImageUpload = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    if (!apiKey) {
      setImportError("画像解析にはAnthropic APIキーが必要です。下の「AI機能の設定」からご自身のキーを登録してください。");
      e.target.value = "";
      return;
    }
    setImportError("");
    setImageImporting(true);
    setImageStage("画像を解析中…");

    const readAsBase64 = (file) =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) =>
          resolve({ base64: String(ev.target.result).split(",")[1], mediaType: file.type || "image/jpeg" });
        reader.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
        reader.readAsDataURL(file);
      });

    (async () => {
      try {
        const limited = files.slice(0, 6);
        const images = await Promise.all(limited.map(readAsBase64));
        const raceContext = `開催場: ${raceInfo.venue || "不明"} / 距離: ${raceInfo.distance ? raceInfo.distance + "m" : "不明"} / 馬場: ${raceInfo.surface}`;

        // --- ステップ1: 画像読み取りのみ(検索なし・軽量) ---
        const visionContent = [
          ...images.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 },
          })),
          {
            type: "text",
            text:
              `${images.length}枚の画像は、競馬の出走表・馬柱・予想印などのスクリーンショットです(同じレースを分割して撮影したものが複数枚含まれる場合もあります)。このレースの条件: ${raceContext}\n\n` +
              `各馬について、写っている情報から次の項目を読み取り、判断できない項目は0(中立)にしてください。\n` +
              `- name: 馬名\n` +
              `- jockeyName: 騎手名(不明なら空文字)\n` +
              `- runningStyle: 脚質。"逃げ","先行","差し","追込" のいずれか(不明なら"先行")\n` +
              `- weight: 斤量(kg、数値のみ。不明なら55)\n` +
              `- conditionFit: 馬場適性(当日の馬場状態・天候への適性)を -2〜2 の整数で(◎=2,○=1,△=0,▲=-1,×=-2)\n` +
              `- courseFit: コース・距離適性を -2〜2の整数で\n` +
              `- training: 追い切り(調教)評価を -2〜2の整数で\n` +
              `- paceFit: 想定レース展開(ペース)との相性を -2〜2の整数で\n` +
              `最大18頭まで。出力は次のJSON形式のみとし、説明文やコードブロック記号は一切つけないでください(検索は行わないでください)。\n` +
              `{"horses":[{"name":"馬名","jockeyName":"騎手名","runningStyle":"先行","weight":55,"conditionFit":0,"courseFit":0,"training":0,"paceFit":0}]}`,
          },
        ];

        const visionResponse = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1600,
            messages: [{ role: "user", content: visionContent }],
          }),
        });

        const visionData = await visionResponse.json();
        if (!visionResponse.ok || visionData.error) {
          setImportError(`APIエラー: ${(visionData.error && visionData.error.message) || visionResponse.status}`);
          return;
        }

        const visionText = extractText(visionData.content);
        const visionMatch = visionText.match(/\{[\s\S]*\}/);
        if (!visionMatch) {
          setImportError(`解析結果の形式を読み取れませんでした。応答: ${visionText.slice(0, 120) || "(空の応答)"}`);
          return;
        }

        const visionParsed = JSON.parse(visionMatch[0]);
        const rawHorses = (Array.isArray(visionParsed.horses) ? visionParsed.horses : []).filter(
          (h) => h && h.name
        );

        if (rawHorses.length < 3) {
          setImportError("画像から3頭以上のデータを読み取れませんでした。別の画像を試すか、手動で入力してください。");
          return;
        }

        const baseHorses = rawHorses.slice(0, 18).map((h) => ({
          name: String(h.name).trim(),
          jockeyName: h.jockeyName ? String(h.jockeyName).trim() : "",
          runningStyle: RUNNING_STYLES.includes(h.runningStyle) ? h.runningStyle : "先行",
          weight: Number.isFinite(Number(h.weight)) ? Number(h.weight) : 55,
          conditionFit: clampRating(h.conditionFit),
          courseFit: clampRating(h.courseFit),
          training: clampRating(h.training),
          paceFit: clampRating(h.paceFit),
        }));

        // --- ステップ2: 騎手実績はキャッシュ優先、未キャッシュ分だけまとめて検索 ---
        setImageStage("騎手成績を確認中…");
        const uniqueJockeys = [...new Set(baseHorses.map((h) => h.jockeyName).filter(Boolean))];
        const ratingMap = {};

        for (const jockey of uniqueJockeys) {
          const cached = await getCachedJockeyRating(jockey, raceInfo.venue, raceInfo.surface);
          if (cached !== null) ratingMap[jockey] = cached;
        }

        const missingJockeys = uniqueJockeys.filter((j) => !(j in ratingMap));

        if (useJockeySearch && missingJockeys.length > 0) {
          setImageStage(`騎手成績を検索中(${missingJockeys.length}名)…`);
          try {
            const searchResponse = await fetch("https://api.anthropic.com/v1/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
                "anthropic-dangerous-direct-browser-access": "true",
              },
              body: JSON.stringify({
                model: "claude-sonnet-4-6",
                max_tokens: 1200,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text:
                          `次の騎手それぞれについて、${raceContext} に近い条件(同じ開催場・同じ芝orダート・近い距離)での過去3年程度の成績(勝率・連対率など)をWeb検索で調べ、-2〜2のjockeyFit評価を付けてください(◎=2,○=1,△=0,▲=-1,×=-2)。情報が見つからない場合は0にしてください。\n` +
                          `騎手: ${missingJockeys.join("、")}\n` +
                          `出力は次のJSON形式のみとし、説明文やコードブロック記号は一切つけないでください。\n` +
                          `{"jockeys":[{"name":"騎手名","rating":0,"note":"根拠を一言"}]}`,
                      },
                    ],
                  },
                ],
                tools: [{ type: "web_search_20250305", name: "web_search" }],
              }),
            });
            const searchData = await searchResponse.json();
            if (searchResponse.ok && !searchData.error) {
              const searchText = extractText(searchData.content);
              const searchMatch = searchText.match(/\{[\s\S]*\}/);
              if (searchMatch) {
                const parsedSearch = JSON.parse(searchMatch[0]);
                const jlist = Array.isArray(parsedSearch.jockeys) ? parsedSearch.jockeys : [];
                for (const j of jlist) {
                  if (!j || !j.name) continue;
                  const r = clampRating(j.rating);
                  ratingMap[j.name] = r;
                  await setCachedJockeyRating(j.name, raceInfo.venue, raceInfo.surface, r, j.note);
                }
              }
            }
          } catch (searchErr) {
            // 検索に失敗しても致命的にはしない(未取得分は0で継続)
          }
        }

        missingJockeys.forEach((j) => {
          if (!(j in ratingMap)) ratingMap[j] = 0;
        });

        const finalHorses = baseHorses.map((h, i) =>
          makeHorse(i + 1, h.name, {
            runningStyle: h.runningStyle,
            weight: h.weight,
            conditionFit: h.conditionFit,
            courseFit: h.courseFit,
            training: h.training,
            paceFit: h.paceFit,
            jockeyFit: h.jockeyName ? ratingMap[h.jockeyName] ?? 0 : 0,
            manualAbility: null,
          })
        );

        setHorses(finalHorses);
        setResults(null);
      } catch (err) {
        setImportError(`画像の解析に失敗しました: ${(err && err.message) || "不明なエラー"}`);
      } finally {
        setImageImporting(false);
        setImageStage("");
        e.target.value = "";
      }
    })();
  };

  const handleClearJockeyCache = () => {
    setClearingCache(true);
    (async () => {
      try {
        const listResult = await window.storage.list("jockey-rating:", false);
        const keys = (listResult && listResult.keys) || [];
        await Promise.all(keys.map((k) => window.storage.delete(k, false).catch(() => null)));
      } catch (e) {
        // 一覧取得に失敗した場合は何もしない
      } finally {
        setClearingCache(false);
      }
    })();
  };

  const loadPredictions = async () => {
    setPredictionsLoading(true);
    try {
      const listResult = await window.storage.list("prediction:", false);
      const keys = (listResult && listResult.keys) || [];
      const items = [];
      for (const k of keys) {
        try {
          const r = await window.storage.get(k, false);
          if (r && r.value) items.push(JSON.parse(r.value));
        } catch (e) {
          // 個別の読み込み失敗はスキップ
        }
      }
      items.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
      setSavedPredictions(items);
    } catch (e) {
      setSavedPredictions([]);
    } finally {
      setPredictionsLoading(false);
    }
  };

  useEffect(() => {
    loadPredictions();
    (async () => {
      try {
        const r = await window.storage.get("settings:anthropic-api-key");
        if (r && r.value) setApiKey(r.value);
      } catch (e) {
        // 未設定
      }
    })();
  }, []);

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    await window.storage.set("settings:anthropic-api-key", trimmed).catch(() => null);
    setApiKey(trimmed);
    setApiKeyInput("");
  };

  const handleClearApiKey = async () => {
    await window.storage.delete("settings:anthropic-api-key").catch(() => null);
    setApiKey("");
  };

  const handleSavePrediction = async () => {
    if (!results) return;
    setSavingPrediction(true);
    try {
      const id = `pred_${Date.now()}`;
      const record = {
        id,
        savedAt: new Date().toISOString(),
        raceLabel: raceLabel.trim() || "(ラベル未設定)",
        venue: raceInfo.venue,
        distance: raceInfo.distance,
        surface: raceInfo.surface,
        horses: results.map((h) => ({
          name: h.name,
          winRate: h.winRate,
          placeRate: h.placeRate,
          showRate: h.showRate,
        })),
        actualResult: null,
      };
      await window.storage.set(`prediction:${id}`, JSON.stringify(record), false);
      setSavedPredictions((prev) => [record, ...prev]);
      setRaceLabel("");
    } catch (e) {
      // 保存失敗時は何もしない(結果画面はそのまま残る)
    } finally {
      setSavingPrediction(false);
    }
  };

  const handleRecordActual = (predictionId, winName) => {
    setSavedPredictions((prev) =>
      prev.map((p) => {
        if (p.id !== predictionId) return p;
        const top3Names = p.horses.slice(0, 3).map((h) => h.name);
        const hitWin = p.horses[0] && p.horses[0].name === winName;
        const hitShow = top3Names.includes(winName);
        const updated = {
          ...p,
          actualResult: { winName, hitWin, hitShow, recordedAt: new Date().toISOString() },
        };
        window.storage.set(`prediction:${p.id}`, JSON.stringify(updated), false).catch(() => null);
        return updated;
      })
    );
  };

  const handleDeletePrediction = (predictionId) => {
    setSavedPredictions((prev) => prev.filter((p) => p.id !== predictionId));
    window.storage.delete(`prediction:${predictionId}`, false).catch(() => null);
  };

  const recordedPredictions = savedPredictions.filter((p) => p.actualResult);
  const winHits = recordedPredictions.filter((p) => p.actualResult.hitWin).length;
  const showHits = recordedPredictions.filter((p) => p.actualResult.hitShow).length;

  const handleRun = () => {
    setRunning(true);
    setResults(null);
    setCounter(0);
    const abilityHorses = computedHorses;
    const speeds = abilityHorses.map(
      (h) => 0.72 + (h.ability / 100) * 0.5 + (Math.random() * 0.3 - 0.15)
    );
    const start = performance.now();

    const tick = (now) => {
      const elapsed = now - start;
      const rawProgress = Math.min(elapsed / RUN_DURATION, 1);
      const eased = 1 - Math.pow(1 - rawProgress, 3);
      setCounter(Math.floor(eased * TRIALS));
      setProgress(
        speeds.map((s, i) => {
          const jitter = Math.sin(now / 130 + i * 1.7) * 1.4;
          return Math.max(0, Math.min(94, eased * 100 * s + jitter));
        })
      );
      if (rawProgress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        const computed = runSimulation(abilityHorses, variance);
        setResults(computed);
        setRunning(false);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => rafRef.current && cancelAnimationFrame(rafRef.current), []);

  useEffect(() => {
    if (inputMode !== "factors") return;
    const { total } = computeFactorVariance(raceFactors, horses.length);
    setVariance(total);
  }, [inputMode, raceFactors, horses.length]);

  return (
    <div className="min-h-screen w-full p-4 md:p-8" style={{ background: PALETTE.fieldDark, fontFamily: SANS }}>
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <div
            className="inline-block text-xs tracking-wide mb-2 px-2 py-1 rounded-sm"
            style={{ background: PALETTE.gold, color: PALETTE.ink, fontWeight: 700 }}
          >
            MONTE CARLO RACE LAB
          </div>
          <h1 className="text-2xl md:text-3xl font-bold mb-1" style={{ color: PALETTE.paper }}>
            着順シミュレーター
          </h1>
          <p className="text-sm" style={{ color: PALETTE.slate }}>
            出走馬の能力値をもとに {TRIALS.toLocaleString()} 回のレースを仮想的に走らせ、勝率・連対率・複勝率を算出します。
          </p>
        </div>

        {/* 出走表 */}
        <div className="rounded-lg p-4 md:p-5 mb-5" style={{ background: PALETTE.paper }}>
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h2 className="text-sm font-bold" style={{ color: PALETTE.ink }}>
              出走表
            </h2>
            <div className="flex gap-2 flex-wrap">
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleCSVUpload} style={{ display: "none" }} />
              <button
                onClick={handleCSVButtonClick}
                className="text-xs px-2 py-1 rounded-sm"
                style={{ background: PALETTE.slate, color: PALETTE.paper, fontWeight: 600 }}
              >
                CSVを読み込む
              </button>
              <input ref={imageInputRef} type="file" accept="image/*" multiple onChange={handleImageUpload} style={{ display: "none" }} />
              <button
                onClick={handleImageButtonClick}
                disabled={imageImporting}
                className="text-xs px-2 py-1 rounded-sm"
                style={{
                  background: imageImporting ? PALETTE.paperDark : PALETTE.crimson,
                  color: imageImporting ? PALETTE.slate : PALETTE.paper,
                  fontWeight: 600,
                }}
              >
                {imageImporting ? imageStage || "解析中…" : "画像から読み込む"}
              </button>
              <button
                onClick={addHorse}
                disabled={horses.length >= 18}
                className="text-xs px-2 py-1 rounded-sm"
                style={{
                  background: horses.length >= 18 ? PALETTE.paperDark : PALETTE.field,
                  color: horses.length >= 18 ? PALETTE.slate : PALETTE.paper,
                  fontWeight: 600,
                }}
              >
                ＋ 馬を追加
              </button>
            </div>
          </div>

          <p className="text-xs mb-2" style={{ color: PALETTE.slate }}>
            画像読み込みでは、馬場適性・コース適性・追い切り・展開適性・脚質・斤量を各馬ごとに読み取ります。騎手実績は開催場・馬場ごとにキャッシュされ、未取得の騎手だけWeb検索で調べます。結果は下の「詳細」から確認・修正できます。
          </p>

          <div className="rounded-sm p-2.5 mb-3" style={{ background: PALETTE.paperDark }}>
            <button
              onClick={() => setShowApiKeySettings((v) => !v)}
              className="text-xs flex items-center gap-1.5"
              style={{ color: PALETTE.ink, fontWeight: 700 }}
            >
              {showApiKeySettings ? "▾" : "▸"} AI機能の設定(画像解析を使う場合のみ・任意)
              <span
                className="text-xs px-1.5 py-0.5 rounded-sm"
                style={{ background: apiKey ? PALETTE.field : PALETTE.crimson, color: PALETTE.paper, fontWeight: 700 }}
              >
                {apiKey ? "設定済み" : "未設定"}
              </span>
            </button>
            {showApiKeySettings && (
              <div className="mt-2">
                <p className="text-xs mb-2" style={{ color: PALETTE.slate }}>
                  画像解析・騎手検索はあなた自身のAnthropic APIキーで動作し、Anthropicの従量課金が発生します(このアプリ自体は無料です)。キーはこの端末のブラウザにのみ保存され、どこにも送信されません。
                  キーをお持ちでない場合は{" "}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: PALETTE.crimson, textDecoration: "underline" }}
                  >
                    console.anthropic.com
                  </a>{" "}
                  で発行できます。設定しなくても、手入力・CSV読み込み・シミュレーション本体は無料で使えます。
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="sk-ant-..."
                    className="flex-1 text-xs p-2 rounded-sm"
                    style={{ background: PALETTE.paper, color: PALETTE.ink, border: "none" }}
                  />
                  <button
                    onClick={handleSaveApiKey}
                    className="text-xs px-3 py-2 rounded-sm shrink-0"
                    style={{ background: PALETTE.field, color: PALETTE.paper, fontWeight: 700 }}
                  >
                    保存
                  </button>
                  {apiKey && (
                    <button
                      onClick={handleClearApiKey}
                      className="text-xs px-2 py-2 rounded-sm shrink-0"
                      style={{ background: PALETTE.paper, color: PALETTE.crimson }}
                    >
                      削除
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs" style={{ color: PALETTE.ink }}>
              <input
                type="checkbox"
                checked={useJockeySearch}
                onChange={(e) => setUseJockeySearch(e.target.checked)}
              />
              騎手実績を未キャッシュ分のみWeb検索する
            </label>
            <button
              onClick={handleClearJockeyCache}
              disabled={clearingCache}
              className="text-xs px-2 py-1 rounded-sm"
              style={{ background: PALETTE.paperDark, color: PALETTE.ink }}
            >
              {clearingCache ? "消去中…" : "騎手キャッシュを消去"}
            </button>
          </div>
          {importError && (
            <p className="text-xs mb-3" style={{ color: PALETTE.crimson }}>
              {importError}
            </p>
          )}

          <div className="grid grid-cols-3 gap-2 mb-4">
            <div>
              <label className="text-xs block mb-1" style={{ color: PALETTE.ink }}>
                開催場
              </label>
              <input
                value={raceInfo.venue}
                onChange={(e) => setRaceInfo((f) => ({ ...f, venue: e.target.value }))}
                placeholder="例: 東京"
                className="w-full text-xs p-1.5 rounded-sm"
                style={{ background: PALETTE.paperDark, color: PALETTE.ink, border: "none" }}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: PALETTE.ink }}>
                距離(m)
              </label>
              <input
                value={raceInfo.distance}
                onChange={(e) => setRaceInfo((f) => ({ ...f, distance: e.target.value }))}
                placeholder="例: 1600"
                className="w-full text-xs p-1.5 rounded-sm"
                style={{ background: PALETTE.paperDark, color: PALETTE.ink, border: "none" }}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: PALETTE.ink }}>
                馬場
              </label>
              <select
                value={raceInfo.surface}
                onChange={(e) => setRaceInfo((f) => ({ ...f, surface: e.target.value }))}
                className="w-full text-xs p-1.5 rounded-sm"
                style={{ background: PALETTE.paperDark, color: PALETTE.ink, border: "none" }}
              >
                <option value="芝">芝</option>
                <option value="ダート">ダート</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            {computedHorses.map((h, idx) => {
              const isExpanded = !!expandedIds[h.id];
              const isManual = h.manualAbility !== null && h.manualAbility !== undefined;
              const biasAdj = computeBiasFit(h.runningStyle, raceFactors.bias);
              const biasLabel = biasAdj > 0 ? "◎ 相性良し" : biasAdj < 0 ? "▲ 相性やや不利" : "△ 中立";

              return (
                <div key={h.id} className="rounded-sm overflow-hidden" style={{ background: PALETTE.paperDark }}>
                  <div className="p-2 pb-1.5">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-sm flex items-center justify-center text-xs shrink-0"
                        style={{ background: PALETTE.field, color: PALETTE.paper, fontFamily: MONO, fontWeight: 700 }}
                      >
                        {idx + 1}
                      </div>
                      <input
                        value={h.name}
                        onChange={(e) => updateHorse(h.id, "name", e.target.value)}
                        className="px-2 py-1.5 rounded-sm flex-1 min-w-0"
                        style={{
                          background: PALETTE.paper,
                          color: PALETTE.ink,
                          border: "none",
                          outline: "none",
                          fontSize: "16px",
                          fontWeight: 700,
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 px-2 pb-2 flex-wrap">
                    <select
                      value={h.runningStyle}
                      onChange={(e) => updateHorse(h.id, "runningStyle", e.target.value)}
                      className="text-xs p-1 rounded-sm shrink-0"
                      style={{ background: PALETTE.paper, color: PALETTE.ink, border: "none" }}
                    >
                      {RUNNING_STYLES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        type="number"
                        value={h.weight}
                        onChange={(e) => updateHorse(h.id, "weight", Number(e.target.value))}
                        className="text-xs p-1 rounded-sm w-12 text-right"
                        style={{ background: PALETTE.paper, color: PALETTE.ink, border: "none" }}
                      />
                      <span className="text-xs" style={{ color: PALETTE.ink }}>
                        kg
                      </span>
                    </div>
                    <div
                      className="text-xs px-2 py-1 rounded-sm shrink-0"
                      style={{ background: PALETTE.field, color: PALETTE.gold, fontFamily: MONO, fontWeight: 700 }}
                    >
                      能力 {h.ability}
                    </div>
                    <button
                      onClick={() => toggleExpand(h.id)}
                      className="text-xs px-1.5 py-1 rounded-sm shrink-0"
                      style={{ background: "transparent", color: PALETTE.ink, textDecoration: "underline" }}
                    >
                      {isExpanded ? "▾ 詳細" : "▸ 詳細"}
                    </button>
                    <button
                      onClick={() => removeHorse(h.id)}
                      disabled={horses.length <= 3}
                      className="text-xs w-6 h-6 rounded-sm shrink-0 ml-auto"
                      style={{ color: horses.length <= 3 ? PALETTE.paperDark : PALETTE.crimson, background: "transparent" }}
                    >
                      ×
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="p-2.5 pt-0">
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
                        {FACTOR_DEFS.map((f) => (
                          <RatingPicker
                            key={f.key}
                            label={f.label}
                            value={h[f.key]}
                            onChange={(v) => setFactor(h.id, f.key, v)}
                          />
                        ))}
                      </div>
                      <div className="flex items-center justify-between text-xs mb-2" style={{ color: PALETTE.ink }}>
                        <span>トラックバイアスとの相性(脚質から自動判定)</span>
                        <span style={{ fontWeight: 700 }}>{biasLabel}</span>
                      </div>
                      <div className="flex items-center gap-2 pt-2" style={{ borderTop: `1px solid ${PALETTE.paper}` }}>
                        <button
                          onClick={() => toggleManualAbility(h.id, h.ability)}
                          className="text-xs px-2 py-1 rounded-sm"
                          style={{ background: isManual ? PALETTE.crimson : PALETTE.paper, color: isManual ? PALETTE.paper : PALETTE.ink }}
                        >
                          {isManual ? "能力値を手動指定中" : "能力値を手動で指定する"}
                        </button>
                        {isManual && (
                          <input
                            type="range"
                            min="1"
                            max="100"
                            value={h.manualAbility}
                            onChange={(e) => updateHorse(h.id, "manualAbility", Number(e.target.value))}
                            className="flex-1"
                          />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 波乱指数 & 実行 */}
        <div className="rounded-lg p-4 md:p-5 mb-5 flex flex-col md:flex-row md:items-center gap-4" style={{ background: PALETTE.paper }}>
          <div className="flex-1">
            <div className="flex gap-1.5 mb-3">
              <button
                onClick={() => setInputMode("preset")}
                className="text-xs px-2.5 py-1 rounded-sm"
                style={{
                  background: inputMode === "preset" ? PALETTE.field : PALETTE.paperDark,
                  color: inputMode === "preset" ? PALETTE.paper : PALETTE.ink,
                  fontWeight: 700,
                }}
              >
                簡単選択
              </button>
              <button
                onClick={() => setInputMode("factors")}
                className="text-xs px-2.5 py-1 rounded-sm"
                style={{
                  background: inputMode === "factors" ? PALETTE.field : PALETTE.paperDark,
                  color: inputMode === "factors" ? PALETTE.paper : PALETTE.ink,
                  fontWeight: 700,
                }}
              >
                レース条件から算出
              </button>
            </div>

            {inputMode === "preset" && (
              <>
                <div className="text-xs mb-2" style={{ color: PALETTE.ink, fontWeight: 700 }}>
                  レースの荒れ具合
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2">
                  {VARIANCE_PRESETS.map((p) => {
                    const isActive = Math.abs(variance - p.value) < 0.01;
                    return (
                      <button
                        key={p.label}
                        onClick={() => setVariance(p.value)}
                        className="text-left px-2 py-1.5 rounded-sm"
                        style={{ background: isActive ? PALETTE.field : PALETTE.paperDark, color: isActive ? PALETTE.paper : PALETTE.ink }}
                      >
                        <div className="text-xs" style={{ fontWeight: 700 }}>
                          {p.label}
                        </div>
                        <div className="text-xs" style={{ color: isActive ? PALETTE.paperDark : PALETTE.slate, opacity: isActive ? 0.85 : 1 }}>
                          {p.desc}
                        </div>
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="text-xs"
                  style={{ color: PALETTE.slate, textDecoration: "underline" }}
                >
                  {showAdvanced ? "▾ 細かく調整する" : "▸ 細かく調整する"}
                </button>
                {showAdvanced && (
                  <div className="mt-2">
                    <div className="flex justify-between text-xs mb-1" style={{ color: PALETTE.ink }}>
                      <span>波乱度(数値)</span>
                      <span style={{ fontFamily: MONO, fontWeight: 700 }}>{variance.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min="0.3"
                      max="2.5"
                      step="0.05"
                      value={variance}
                      onChange={(e) => setVariance(Number(e.target.value))}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs mt-1" style={{ color: PALETTE.slate }}>
                      <span>堅い決着</span>
                      <span>大波乱</span>
                    </div>
                  </div>
                )}
              </>
            )}

            {inputMode === "factors" && (
              <div>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <div>
                    <label className="text-xs block mb-1" style={{ color: PALETTE.ink }}>
                      天候
                    </label>
                    <select
                      value={raceFactors.weather}
                      onChange={(e) => setRaceFactors((f) => ({ ...f, weather: e.target.value }))}
                      className="w-full text-xs p-1.5 rounded-sm"
                      style={{ background: PALETTE.paperDark, color: PALETTE.ink, border: "none" }}
                    >
                      {WEATHER_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: PALETTE.ink }}>
                      馬場状態
                    </label>
                    <select
                      value={raceFactors.track}
                      onChange={(e) => setRaceFactors((f) => ({ ...f, track: e.target.value }))}
                      className="w-full text-xs p-1.5 rounded-sm"
                      style={{ background: PALETTE.paperDark, color: PALETTE.ink, border: "none" }}
                    >
                      {TRACK_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: PALETTE.ink }}>
                      トラックバイアス
                    </label>
                    <select
                      value={raceFactors.bias}
                      onChange={(e) => setRaceFactors((f) => ({ ...f, bias: e.target.value }))}
                      className="w-full text-xs p-1.5 rounded-sm"
                      style={{ background: PALETTE.paperDark, color: PALETTE.ink, border: "none" }}
                    >
                      {BIAS_OPTIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {(() => {
                  const { breakdown, total } = computeFactorVariance(raceFactors, horses.length);
                  return (
                    <div className="rounded-sm p-2.5" style={{ background: PALETTE.paperDark }}>
                      {breakdown.map((b) => (
                        <div key={b.label} className="flex justify-between text-xs mb-0.5" style={{ color: PALETTE.ink }}>
                          <span>{b.label}</span>
                          <span style={{ fontFamily: MONO }}>{b.value >= 0 ? `+${b.value.toFixed(2)}` : b.value.toFixed(2)}</span>
                        </div>
                      ))}
                      <div
                        className="flex justify-between text-xs mt-1.5 pt-1.5"
                        style={{ borderTop: `1px solid ${PALETTE.paper}`, color: PALETTE.ink, fontWeight: 700 }}
                      >
                        <span>波乱指数</span>
                        <span style={{ fontFamily: MONO }}>{total.toFixed(2)}</span>
                      </div>
                    </div>
                  );
                })()}
                <p className="text-xs mt-1.5" style={{ color: PALETTE.slate }}>
                  出走頭数は出走表の登録数({horses.length}頭)から自動反映されます。トラックバイアスは各馬の脚質と照らして能力値にも反映されます。
                </p>
              </div>
            )}
          </div>
          <button
            onClick={handleRun}
            disabled={running}
            className="px-5 py-3 rounded-sm text-sm shrink-0"
            style={{ background: running ? PALETTE.paperDark : PALETTE.crimson, color: running ? PALETTE.slate : PALETTE.paper, fontWeight: 700 }}
          >
            {running ? "レース中…" : "シミュレーション開始"}
          </button>
        </div>

        {/* 結果ボード */}
        <div className="rounded-lg p-4 md:p-5" style={{ background: PALETTE.field, border: `1px solid ${PALETTE.fieldLine}` }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold" style={{ color: PALETTE.paper }}>
              {running ? "レース進行中" : "シミュレーション結果"}
            </h2>
            <span className="text-xs tabular-nums" style={{ color: PALETTE.gold, fontFamily: MONO }}>
              試行回数: {(running ? counter : results ? TRIALS : 0).toLocaleString()} 回
            </span>
          </div>

          {!results && !running && (
            <p className="text-sm py-8 text-center" style={{ color: PALETTE.slate }}>
              「シミュレーション開始」を押すと結果が表示されます
            </p>
          )}

          {running && <RaceTrack horses={computedHorses} progress={progress} />}

          {results && !running && (
            <div className="space-y-4">
              {results.map((h, i) => (
                <div key={h.id} className="pb-3" style={{ borderBottom: i < horses.length - 1 ? `1px solid ${PALETTE.fieldLine}` : "none" }}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-xs px-1.5 py-0.5 rounded-sm" style={{ background: PALETTE.gold, color: PALETTE.ink, fontWeight: 700 }}>
                      {i + 1}
                    </span>
                    <span className="text-sm font-bold" style={{ color: PALETTE.paper }}>
                      {h.name}
                    </span>
                    <span className="text-xs" style={{ color: PALETTE.slate, fontFamily: MONO }}>
                      能力{h.ability}
                    </span>
                  </div>
                  <div className="space-y-1 pl-1">
                    <Bar label="勝率" value={h.winRate} color={PALETTE.gold} delay={i * 40} />
                    <Bar label="連対率" value={h.placeRate} color={PALETTE.goldBright} delay={i * 40 + 15} />
                    <Bar label="複勝率" value={h.showRate} color={"#8FA89C"} delay={i * 40 + 30} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 予想ログ */}
        <div className="rounded-lg p-4 md:p-5 mt-5" style={{ background: PALETTE.paper }}>
          <h2 className="text-sm font-bold mb-3" style={{ color: PALETTE.ink }}>
            予想ログ
          </h2>

          {results && (
            <div className="flex gap-2 mb-3">
              <input
                value={raceLabel}
                onChange={(e) => setRaceLabel(e.target.value)}
                placeholder="例: 7/26 新潟1R"
                className="flex-1 text-xs p-2 rounded-sm"
                style={{ background: PALETTE.paperDark, color: PALETTE.ink, border: "none" }}
              />
              <button
                onClick={handleSavePrediction}
                disabled={savingPrediction}
                className="text-xs px-3 py-2 rounded-sm shrink-0"
                style={{ background: PALETTE.field, color: PALETTE.paper, fontWeight: 700 }}
              >
                {savingPrediction ? "保存中…" : "この予想を記録"}
              </button>
            </div>
          )}

          {recordedPredictions.length > 0 && (
            <div className="flex gap-4 mb-3 text-xs flex-wrap" style={{ color: PALETTE.ink }}>
              <div>
                単勝的中率: <b style={{ fontFamily: MONO }}>{((winHits / recordedPredictions.length) * 100).toFixed(0)}%</b> (
                {winHits}/{recordedPredictions.length})
              </div>
              <div>
                複勝的中率: <b style={{ fontFamily: MONO }}>{((showHits / recordedPredictions.length) * 100).toFixed(0)}%</b> (
                {showHits}/{recordedPredictions.length})
              </div>
            </div>
          )}

          {predictionsLoading && (
            <p className="text-xs" style={{ color: PALETTE.slate }}>
              読み込み中…
            </p>
          )}

          {!predictionsLoading && savedPredictions.length === 0 && (
            <p className="text-xs" style={{ color: PALETTE.slate }}>
              まだ記録がありません。シミュレーション結果が出たら「この予想を記録」で保存できます。
            </p>
          )}

          <div className="space-y-2">
            {savedPredictions.map((p) => (
              <PredictionRow key={p.id} prediction={p} onRecord={handleRecordActual} onDelete={handleDeletePrediction} />
            ))}
          </div>
        </div>

        <p className="text-xs mt-4" style={{ color: PALETTE.slate }}>
          ※ これは能力値に基づく仮想シミュレーションです。実際のレース結果を予測・保証するものではありません。読み取り結果や算出値は必ず確認し、ご自身の予想根拠に応じて調整してください。予想ログはこの端末・ブラウザにのみ保存されます。
        </p>
      </div>
    </div>
  );
}
