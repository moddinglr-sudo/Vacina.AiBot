import express from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '50mb' }))

// ── CORS ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
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
  const { provider, model, apiKey, messages, systemPrompt } = req.body

  console.log(`\n📨 [${provider?.toUpperCase()}] modelo: ${model}`)
  console.log(`   Mensagens: ${messages?.length || 0} | System: ${systemPrompt ? 'sim' : 'não'}`)

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
      const mistralMessages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...(messages || [])
      ]

      const mistralRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || 'mistral-large-latest',
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