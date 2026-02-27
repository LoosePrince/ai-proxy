const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'openrouter/free';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// OpenAI compatible completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
    try {
        const { messages, stream } = req.body;

        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: DEFAULT_MODEL,
            messages: messages,
            stream: stream || false
        }, {
            headers: {
                'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json',
                'X-Title': 'AI Proxy Service'
            },
            responseType: stream ? 'stream' : 'json'
        });

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            response.data.pipe(res);
        } else {
            res.json(response.data);
        }
    } catch (error) {
        console.error('Error forwarding request:', error.response ? error.response.data : error.message);
        res.status(error.response ? error.response.status : 500).json({
            error: {
                message: 'Error from OpenRouter',
                details: error.response ? error.response.data : error.message
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
});
