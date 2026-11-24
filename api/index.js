const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 600;
const OPENAI_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = [
  "Ты мой голосовой ассистент и кореш. Говори со мной на «ты», по-русски, живо и по делу, как в разговоре с давним другом.",
  "Этот стиль действует во всех ответах, даже на обычные вопросы про науку, историю или быт. Можно начать с «Слушай», «Значит так, ё-моё» или сразу с сути. Меняй формулировки, чтобы не звучать как заезженная пластинка.",
  "Спокойно используй мат, острый юмор и пошлые шутки. Если я сам говорю с матом, подхватывай мой тон. Мат может быть естественной частью фразы, а не отдельным представлением. Не пихай его в каждое предложение.",
  "Если я прошу анекдот, рассказывай его сразу. Если прошу с матом, используй настоящий мат без звёздочек и эвфемизмов. Например, в анекдоте про генерала солдат может сказать «Да какого хуя, товарищ генерал?», если это работает на шутку. Не объявляй, что сейчас будет грубо, и не объясняй шутку после концовки.",
  "Если я спрашиваю, почему кенгуру живут в Австралии, ответ может звучать так: «Значит так, ё-моё. Австралия миллионы лет жила отдельно от других материков, и сумчатые там развивались своим путём. Вот и получился континент, где кенгуру у себя дома».",
  "Для колонки обычно хватает одного-трёх коротких предложений. Если я прошу объяснить подробнее или шутке нужна завязка, говори чуть дольше. Пиши так, чтобы ответ хорошо звучал вслух. Избегай Markdown, таблиц и канцелярита.",
  "Точность важнее подкола. Если не знаешь, скажи прямо. Если вопрос про свежие данные и тебе передали результаты поиска, опирайся на них и не выдумывай недостающие факты."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) return text || "Не удалось подготовить ответ.";

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );
  if (sentenceEnd >= 300) return candidate.slice(0, sentenceEnd + 1).trim();

  const lastSpace = candidate.lastIndexOf(" ");
  return (lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(item => item && (item.role === "user" || item.role === "model") && typeof item.text === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({ role: item.role, text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;
  if (!key || timeoutMs < 150) return "";

  try {
    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ q: query, gl: "ru", hl: "ru", num: 3 })
      },
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn("Serper request failed with HTTP", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, i) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);
        return `${i + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;
    if (answerBox) items.unshift(`Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`);
    return items.length ? items.join("\n") : "";
  } catch (error) {
    console.warn("Serper request did not finish in time; continuing without search.");
    return "";
  }
}

async function askOpenAI(text, history, searchContext, timeoutMs) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("MISSING_OPENAI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const input = safeHistory(history).map(item => ({
    role: item.role === "model" ? "assistant" : "user",
    content: item.text
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их как справочные данные по вопросу.`
    : text;
  input.push({ role: "user", content: prompt });

  const { response, data } = await fetchJson(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        instructions: SYSTEM_PROMPT,
        input,
        max_output_tokens: 240,
        store: false
      })
    },
    Math.min(OPENAI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = response.status;
    const code = data?.error?.code;
    console.error("OpenAI request failed with HTTP", status, code);
    if (code === "model_not_found") throw new Error("OPENAI_MODEL_UNAVAILABLE");
    if (status === 401 || status === 403) throw new Error("OPENAI_ACCESS_DENIED");
    if (status === 429) throw new Error("OPENAI_QUOTA");
    throw new Error("OPENAI_REQUEST_FAILED");
  }

  const content = (data.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || []);
  const answer = content
    .filter(part => part.type === "output_text")
    .map(part => part.text)
    .join(" ")
    .trim();

  if (answer) return answer;
  if (content.some(part => part.type === "refusal")) throw new Error("OPENAI_BLOCKED");
  throw new Error("OPENAI_EMPTY_RESPONSE");
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_OPENAI_KEY":
      return "Сервер пока не настроен. Проверьте переменную OPENAI_API_KEY в настройках Vercel.";
    case "OPENAI_ACCESS_DENIED":
      return "Не удалось подключиться к OpenAI. Проверьте API-ключ и доступ к OpenAI.";
    case "OPENAI_QUOTA":
      return "Сейчас превышен лимит запросов к OpenAI. Проверьте баланс API или попробуйте позже.";
    case "OPENAI_MODEL_UNAVAILABLE":
      return "Модель OpenAI недоступна. Проверьте настройку OPENAI_MODEL в Vercel."
    case "OPENAI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";
    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Не успела подготовить ответ. Попробуйте задать вопрос ещё раз, чуть короче.";
    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-openai-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const startedAt = Date.now();
  const remainingMs = () => TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const text = String(body?.request?.command || body?.request?.original_utterance || "").trim();
  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(aliceResponse(
      "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
      false,
      oldHistory
    ));
  }

  try {
    let searchContext = "";
    if (isSearchIntent(text) && process.env.SERPER_API_KEY) {
      // Search has a very short budget because Alice expects a response within 4.5 seconds.
      searchContext = await searchWeb(text, Math.min(SERPER_TIMEOUT_MS, Math.max(0, remainingMs() - 2600)));
    }

    const answer = await askOpenAI(
      text,
      oldHistory,
      searchContext,
      Math.max(0, Math.min(OPENAI_TIMEOUT_MS, remainingMs() - 600))
    );

    const history = [
      ...oldHistory,
      { role: "user", text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS) },
      { role: "model", text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS) }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(aliceResponse(answer, false, history));
  } catch (error) {
    const safeError = error?.name === "AbortError" ? "TIME_BUDGET_EXHAUSTED" : error;
    console.warn("Alice webhook returned a fallback response:", safeError?.message || "unknown error");
    return res.status(200).json(aliceResponse(errorForUser(safeError), false, oldHistory));
  }
}

export { aliceResponse, fitAliceText, isSearchIntent, safeHistory };
