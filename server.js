import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '50mb' }))

// Proteções básicas para a API pública. Conteúdo e chaves não são registrados.
const requestBuckets = new Map()
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 30
app.use('/api', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const bucket = (requestBuckets.get(ip) || []).filter(time => now - time < RATE_WINDOW_MS)
  if (bucket.length >= RATE_LIMIT) return res.status(429).json({ response: 'Muitas solicitações. Aguarde um minuto e tente novamente.' })
  bucket.push(now); requestBuckets.set(ip, bucket)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  next()
})

// ── CORS ──
// A interface é entregue pelo mesmo servidor. Não abra esta API para qualquer site,
// pois o navegador poderia encaminhar a chave local do usuário a partir de uma origem não confiável.
app.use((req, res, next) => {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)
  const origin = req.headers.origin
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')
  }
  if (req.method === 'OPTIONS') return origin && allowedOrigins.includes(origin) ? res.sendStatus(204) : res.sendStatus(403)
  next()
})

// ── SERVIR FRONTEND ──
// Tenta servir da mesma pasta, de ./frontend e de ../frontend
app.use(express.static(path.join(__dirname)))
app.use(express.static(path.join(__dirname, 'frontend')))
app.use(express.static(path.join(__dirname, '../frontend')))

// Rota raiz — procura o HTML em múltiplos lugares
app.get('/', (req, res) => {
  const candidates = [
    path.join(__dirname, 'vacina-chatbot.html'),
    path.join(__dirname, 'frontend', 'vacina-chatbot.html'),
    path.join(__dirname, '../frontend', 'vacina-chatbot.html'),
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'frontend', 'index.html'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return res.sendFile(p)
  }
  res.send(`
    <h2>VaccinaBot Server está rodando ✅</h2>
    <p>Mas o arquivo <b>vacina-chatbot.html</b> não foi encontrado.</p>
    <p>Coloque o HTML na mesma pasta do server.js ou numa pasta chamada <b>frontend</b>.</p>
    <p>Estrutura esperada:</p>
    <pre>
pasta/
├── server.js
├── package.json
└── vacina-chatbot.html   ← aqui
    </pre>
  `)
})

// ── ROTA CHAT UNIFICADA ──
// Body esperado:
// { provider, model, apiKey, messages, systemPrompt }
app.post('/api/chat', async (req, res) => {
  const { provider, model, apiKey, messages, systemPrompt, image } = req.body

  if (!['ollama', 'anthropic', 'openai', 'mistral'].includes(provider)) {
    return res.status(400).json({ response: 'Provedor inválido.' })
  }
  if (!Array.isArray(messages) || messages.length > 40 || !messages.every(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string' && m.content.length <= 20_000)) {
    return res.status(400).json({ response: 'Formato ou tamanho de conversa inválido.' })
  }
  if (typeof systemPrompt !== 'string' || systemPrompt.length > 50_000 || (image && (typeof image !== 'string' || image.length > 22_000_000))) {
    return res.status(400).json({ response: 'Conteúdo excede o limite permitido.' })
  }

  console.log(`\n📨 [${provider?.toUpperCase()}] modelo: ${model}`)
  console.log(`   Mensagens: ${messages?.length || 0} | System: ${systemPrompt ? 'sim' : 'não'} | Imagem: ${image ? 'sim' : 'não'}`)

  try {
    let resposta = ''

    // ── OLLAMA ──
    if (provider === 'ollama') {
      // Monta histórico no formato de prompt simples
      const historico = (messages || [])
        .map(m => m.role === 'user' ? `Usuário: ${m.content}` : `Assistente: ${m.content}`)
        .join('\n')

      const promptCompleto = systemPrompt
        ? `${systemPrompt}\n\n${historico}\nAssistente:`
        : `${historico}\nAssistente:`

      const ollamaRes = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || 'llama3.2',
          prompt: promptCompleto,
          stream: false
        })
      })

      if (!ollamaRes.ok) {
        const txt = await ollamaRes.text()
        throw new Error(`Ollama HTTP ${ollamaRes.status}: ${txt.slice(0, 200)}`)
      }

      const data = await ollamaRes.json()
      resposta = data.response || 'Sem resposta.'

    // ── ANTHROPIC (CLAUDE) ──
    } else if (provider === 'anthropic') {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: model || 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt || '',
          messages: messages || []
        })
      })

      if (!claudeRes.ok) {
        const err = await claudeRes.json()
        throw new Error(err.error?.message || `Claude HTTP ${claudeRes.status}`)
      }

      const data = await claudeRes.json()
      resposta = data.content?.[0]?.text || 'Sem resposta.'

    // ── OPENAI ──
    } else if (provider === 'openai') {
      const openaiMessages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...(messages || [])
      ]

      const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || 'gpt-4o',
          max_tokens: 4096,
          messages: openaiMessages
        })
      })

      if (!openaiRes.ok) {
        const err = await openaiRes.json()
        throw new Error(err.error?.message || `OpenAI HTTP ${openaiRes.status}`)
      }

      const data = await openaiRes.json()
      resposta = data.choices?.[0]?.message?.content || 'Sem resposta.'

    // ── MISTRAL ──
    } else if (provider === 'mistral') {
      let mistralMessages

      if (image) {
        // Requisição com imagem (vision): anexa a imagem à última mensagem do usuário
        const priorMessages = (messages || []).slice(0, -1)
        const lastMsg = (messages || [])[(messages || []).length - 1]
        const userText = (lastMsg && lastMsg.content) || 'Descreva esta imagem.'

        mistralMessages = [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...priorMessages,
          {
            role: 'user',
            content: [
              { type: 'text', text: userText },
              { type: 'image_url', image_url: { url: image } }
            ]
          }
        ]
      } else {
        mistralMessages = [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...(messages || [])
        ]
      }

      const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || (image ? 'mistral-small-latest' : 'mistral-large-latest'),
          max_tokens: 4096,
          messages: mistralMessages
        })
      })

      if (!mistralRes.ok) {
        const err = await mistralRes.json()
        throw new Error(err.message || `Mistral HTTP ${mistralRes.status}`)
      }

      const data = await mistralRes.json()
      resposta = data.choices?.[0]?.message?.content || 'Sem resposta.'

    } else {
      throw new Error(`Provedor desconhecido: ${provider}`)
    }

    console.log(`✅ Resposta gerada (${resposta.length} chars)`)
    res.json({ response: resposta })

  } catch (err) {
    console.error(`❌ Erro [${provider}]:`, err.message)
    res.status(500).json({ response: `Erro: ${err.message}` })
  }
})

// ── ROTA STATUS (teste de conexão) ──
app.get('/api/status', async (req, res) => {
  const status = { server: 'ok', ollama: false, modelos: [] }

  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags')
    if (r.ok) {
      const data = await r.json()
      status.ollama = true
      status.modelos = data.models?.map(m => m.name) || []
    }
  } catch (_) {}

  res.json(status)
})

// ── START ──
app.listen(3000, () => {
  console.log('')
  console.log('  ╔══════════════════════════════════════════╗')
  console.log('  ║      VaccinaBot Server                   ║')
  console.log('  ╠══════════════════════════════════════════╣')
  console.log('  ║  Frontend : http://localhost:3000        ║')
  console.log('  ║  API      : http://localhost:3000/api    ║')
  console.log('  ╠══════════════════════════════════════════╣')
  console.log('  ║  Ctrl+C para parar                       ║')
  console.log('  ╚══════════════════════════════════════════╝')
  console.log('')
})
