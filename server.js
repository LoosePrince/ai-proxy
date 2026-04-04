const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;
const SILICONFLOW_BASE_URL = process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1/chat/completions';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'openrouter/free';
const KILO_API_KEY = process.env.KILO_API_KEY;
const KILO_URL = process.env.KILO_URL || 'https://api.kilo.ai/api/gateway/v1/chat/completions';
const KILO_MODEL = process.env.KILO_MODEL || 'kilo-auto/free';
const OPENROUTER_DAILY_LIMIT = 50;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const SILICONFLOW_MODELS = Object.freeze([
    'Qwen/Qwen3.5-4B',
    'PaddlePaddle/PaddleOCR-VL-1.5',
    'PaddlePaddle/PaddleOCR-VL',
    'THUDM/GLM-4.1V-9B-Thinking',
    'deepseek-ai/DeepSeek-R1-0528-Qwen3-8B',
    'Qwen/Qwen3-8B',
    'THUDM/GLM-Z1-9B-0414',
    'THUDM/GLM-4-9B-0414',
    'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
    'Qwen/Qwen2.5-7B-Instruct',
    'internlm/internlm2_5-7b-chat'
]);

let openRouterCount = 0;
let openRouterDay = getToday();

function getToday() {
    return new Date().toISOString().slice(0, 10);
}

function refreshDailyCounter() {
    const today = getToday();
    if (today !== openRouterDay) {
        openRouterDay = today;
        openRouterCount = 0;
    }
}

function canUseOpenRouter() {
    refreshDailyCounter();
    return openRouterCount < OPENROUTER_DAILY_LIMIT;
}

function increaseOpenRouterCount() {
    refreshDailyCounter();
    openRouterCount += 1;
}

function pickRandomSiliconModel() {
    const index = Math.floor(Math.random() * SILICONFLOW_MODELS.length);
    return SILICONFLOW_MODELS[index];
}

function buildPayload(body, model, stream) {
    return {
        ...body,
        model,
        stream
    };
}

async function callProvider({
    url,
    apiKey,
    title,
    payload,
    stream,
    providerName
}) {
    if (!apiKey) {
        throw new Error(`${providerName} API key is not configured`);
    }

    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };
    if (title) {
        headers['X-Title'] = title;
    }

    return axios.post(url, payload, {
        headers,
        responseType: stream ? 'stream' : 'json'
    });
}

function sendProviderResponse(res, axiosResponse, stream) {
    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        axiosResponse.data.pipe(res);
    } else {
        res.json(axiosResponse.data);
    }
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// OpenAI compatible completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
    const stream = !!req.body.stream;
    const basePayload = { ...req.body };

    try {
        if (KILO_API_KEY) {
            try {
                const kiloPayload = buildPayload(basePayload, KILO_MODEL, stream);
                const kiloResponse = await callProvider({
                    url: KILO_URL,
                    apiKey: KILO_API_KEY,
                    title: null,
                    payload: kiloPayload,
                    stream,
                    providerName: 'Kilo'
                });
                sendProviderResponse(res, kiloResponse, stream);
                return;
            } catch (kiloError) {
                const status = kiloError.response ? kiloError.response.status : 'NO_STATUS';
                const details = kiloError.response ? kiloError.response.data : kiloError.message;
                console.warn(`[Kilo] failed, trying next provider. status=${status}`, details);
            }
        }

        if (canUseOpenRouter()) {
            increaseOpenRouterCount();
            try {
                const openRouterPayload = buildPayload(basePayload, DEFAULT_MODEL, stream);
                const response = await callProvider({
                    url: OPENROUTER_URL,
                    apiKey: OPENROUTER_API_KEY,
                    title: 'AI Proxy Service',
                    payload: openRouterPayload,
                    stream,
                    providerName: 'OpenRouter'
                });
                sendProviderResponse(res, response, stream);
                return;
            } catch (openRouterError) {
                const status = openRouterError.response ? openRouterError.response.status : 'NO_STATUS';
                const details = openRouterError.response ? openRouterError.response.data : openRouterError.message;
                console.warn(`[OpenRouter] failed, fallback to SiliconFlow. status=${status}, count=${openRouterCount}/${OPENROUTER_DAILY_LIMIT}`, details);
            }
        } else {
            console.warn(`[OpenRouter] daily limit reached (${openRouterCount}/${OPENROUTER_DAILY_LIMIT}), fallback to SiliconFlow`);
        }

        const fallbackModel = pickRandomSiliconModel();
        const siliconPayload = buildPayload(basePayload, fallbackModel, stream);
        const siliconResponse = await callProvider({
            url: SILICONFLOW_BASE_URL,
            apiKey: SILICONFLOW_API_KEY,
            title: 'AI Proxy Service SiliconFlow Fallback',
            payload: siliconPayload,
            stream,
            providerName: 'SiliconFlow'
        });

        console.log(`[SiliconFlow] fallback model selected: ${fallbackModel}`);
        sendProviderResponse(res, siliconResponse, stream);
    } catch (error) {
        const details = error.response ? error.response.data : error.message;
        console.error('[Proxy] all providers failed:', details);
        res.status(error.response ? error.response.status : 500).json({
            error: {
                message: 'All configured AI providers failed',
                details
            }
        });
    }
});

// Root route to serve the landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    if (!KILO_API_KEY) {
        console.warn('[Kilo] KILO_API_KEY is not configured, primary Kilo path is disabled');
    }
    if (!SILICONFLOW_API_KEY) {
        console.warn('[SiliconFlow] SILICONFLOW_API_KEY is not configured, fallback path will fail');
    }
});
