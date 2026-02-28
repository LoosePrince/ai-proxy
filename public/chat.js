const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const typingIndicator = document.getElementById('typing');

let isGenerating = false;

// 对话历史（页面刷新会丢失）
let conversationHistory = [];

// 初始化时添加系统欢迎消息到历史
conversationHistory.push({
    role: 'assistant',
    content: '你好！我是你的 AI 助手，有什么我可以帮你的吗？'
});

// 渲染 Markdown 文本
function renderMarkdown(text) {
    if (typeof marked !== 'undefined') {
        return marked.parse(text);
    }
    // 如果 marked 未加载，返回纯文本
    return escapeHtml(text).replace(/\n/g, '<br>');
}

// HTML 转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 创建消息元素
function createMessageElement(role) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    chatMessages.appendChild(msgDiv);
    return msgDiv;
}

// 添加用户消息
function appendUserMessage(text) {
    const msgDiv = createMessageElement('user');
    msgDiv.textContent = text;
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return msgDiv;
}

// 添加 AI 消息（带流式更新支持）
function createAIMessage() {
    const msgDiv = createMessageElement('ai');
    const contentSpan = document.createElement('span');
    contentSpan.className = 'ai-content';
    msgDiv.appendChild(contentSpan);

    // 添加流式光标
    const cursor = document.createElement('span');
    cursor.className = 'streaming-cursor';
    msgDiv.appendChild(cursor);

    chatMessages.scrollTop = chatMessages.scrollHeight;

    return {
        element: msgDiv,
        contentSpan: contentSpan,
        cursor: cursor,
        fullText: '',
        update: function(text) {
            this.fullText = text;
            this.contentSpan.innerHTML = renderMarkdown(text);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        },
        finish: function() {
            this.cursor.remove();
            this.update(this.fullText);
        }
    };
}

// 流式发送消息
async function sendMessageStream() {
    const text = userInput.value.trim();
    if (!text || isGenerating) return;

    userInput.value = '';

    // 添加用户消息到界面和历史
    appendUserMessage(text);
    conversationHistory.push({ role: 'user', content: text });

    isGenerating = true;
    sendBtn.disabled = true;
    typingIndicator.style.display = 'block';

    // 创建 AI 消息元素
    const aiMessage = createAIMessage();

    try {
        const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: conversationHistory,
                stream: true
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullContent = '';

        typingIndicator.style.display = 'none';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n');

            for (const line of lines) {
                if (line.trim() === '') continue;
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta?.content;
                        if (delta) {
                            fullContent += delta;
                            aiMessage.update(fullContent);
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }
        }

        aiMessage.finish();

        // 将 AI 回复添加到历史
        conversationHistory.push({
            role: 'assistant',
            content: fullContent
        });

    } catch (error) {
        console.error('Chat error:', error);
        typingIndicator.style.display = 'none';
        aiMessage.update('连接服务器失败，请稍后再试。');
        aiMessage.finish();
    } finally {
        isGenerating = false;
        sendBtn.disabled = false;
    }
}

// 非流式发送消息（备用）
async function sendMessageNonStream() {
    const text = userInput.value.trim();
    if (!text || isGenerating) return;

    userInput.value = '';

    // 添加用户消息到界面和历史
    appendUserMessage(text);
    conversationHistory.push({ role: 'user', content: text });

    isGenerating = true;
    sendBtn.disabled = true;
    typingIndicator.style.display = 'block';

    // 创建 AI 消息元素
    const aiMessage = createAIMessage();

    try {
        const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: conversationHistory,
                stream: false
            })
        });

        typingIndicator.style.display = 'none';

        const data = await response.json();

        if (data.choices && data.choices.length > 0) {
            const content = data.choices[0].message.content;
            aiMessage.update(content);
            aiMessage.finish();

            // 将 AI 回复添加到历史
            conversationHistory.push({
                role: 'assistant',
                content: content
            });
        } else {
            aiMessage.update('抱歉，我现在无法回答。');
            aiMessage.finish();
        }
    } catch (error) {
        console.error('Chat error:', error);
        typingIndicator.style.display = 'none';
        aiMessage.update('连接服务器失败，请稍后再试。');
        aiMessage.finish();
    } finally {
        isGenerating = false;
        sendBtn.disabled = false;
    }
}

// 检测浏览器是否支持流式响应
function isStreamSupported() {
    return typeof ReadableStream !== 'undefined' &&
           typeof Response !== 'undefined' &&
           'body' in Response.prototype;
}

// 发送消息（自动选择流式或非流式）
function sendMessage() {
    if (isStreamSupported()) {
        sendMessageStream();
    } else {
        sendMessageNonStream();
    }
}

// 清空对话历史
function clearHistory() {
    conversationHistory = [];
    chatMessages.innerHTML = '';
    // 重新添加欢迎消息
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'message ai';
    welcomeDiv.innerHTML = renderMarkdown('你好！我是你的 AI 助手，有什么我可以帮你的吗？');
    chatMessages.appendChild(welcomeDiv);
    conversationHistory.push({
        role: 'assistant',
        content: '你好！我是你的 AI 助手，有什么我可以帮你的吗？'
    });
}

// 事件监听
sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});

// 导出函数供外部使用（可选）
window.chatAPI = {
    clearHistory,
    getHistory: () => [...conversationHistory]
};
