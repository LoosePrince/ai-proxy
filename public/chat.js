const chatMessages = document.getElementById('chat-messages');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const typingIndicator = document.getElementById('typing');

let isGenerating = false;

function appendMessage(role, text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    msgDiv.textContent = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return msgDiv;
}

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text || isGenerating) return;

    userInput.value = '';
    appendMessage('user', text);

    isGenerating = true;
    sendBtn.disabled = true;
    typingIndicator.style.display = 'block';

    try {
        const response = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: [{ role: 'user', content: text }]
            })
        });

        const data = await response.json();
        typingIndicator.style.display = 'none';

        if (data.choices && data.choices.length > 0) {
            appendMessage('ai', data.choices[0].message.content);
        } else {
            appendMessage('ai', '抱歉，我现在无法回答。');
        }
    } catch (error) {
        console.error('Chat error:', error);
        typingIndicator.style.display = 'none';
        appendMessage('ai', '连接服务器失败，请稍后再试。');
    } finally {
        isGenerating = false;
        sendBtn.disabled = false;
    }
}

sendBtn.addEventListener('click', sendMessage);
userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});
