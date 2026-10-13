import { Plugin } from "@opencode/plugin"
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// auto-models: sincroniza el opencode.jsonc GLOBAL con tus gateways
// OpenAI-compatibles. Lee providers.<id>.settings.baseURL, pide
// GET {baseURL}/models y añade al mapa providers.<id>.models los IDs
// nuevos sin tocar los existentes. Corre cada 5 minutos y con /sync-models.
// Solo añade, nunca borra: tus límites y claves del jsonc mandan.
// /prune-models (manual) elimina los modelos que ya no expone el gateway
// (añadidos por sync O escritos a mano) y los guarda antes en
// pruned-models.json con su entrada intacta del jsonc, para poder
// restaurarlos con copiar y pegar.
// El servidor recarga la config automáticamente al detectar el cambio.

const INTERVAL_MS = 5 * 60 * 1000
const TIMEOUT_MS = 12_000
const BACKUP_SUFFIX = ".autosync.backup"

function configDir(): string {
  // OpenCode usa ~/.config/opencode en todas las plataformas
  // (en Windows queda en C:\Users\<user>\.config\opencode).
  return process.env.OPENCODE_CONFIG || join(homedir(), ".config", "opencode")
}

function configPath(): string {
  return join(configDir(), "opencode.jsonc")
}

async function dbg(...parts: unknown[]) {
  try {
    await appendFile(join(configDir(), "auto-models-debug.log"), new Date().toISOString() + " " + parts.map(String).join(" ") + "\n")
  } catch {
    // nunca romper el plugin por el log
  }
}

function stripJsonc(text: string): string {
  let out = ""
  let i = 0
  let inStr = false
  let quote = ""
  let inLine = false
  let inBlock = false
  while (i < text.length) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      i++
      continue
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false
        i += 2
      } else i++
      continue
    }
    if (inStr) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i += 2
        continue
      }
      if (c === quote) inStr = false
      i++
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      i++
      continue
    }
    if (c === "/" && n === "/") {
      inLine = true
      i += 2
      continue
    }
    if (c === "/" && n === "*") {
      inBlock = true
      i += 2
      continue
    }
    out += c
    i++
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function parseConfig(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return JSON.parse(stripJsonc(text))
  }
}

// Acepta claves literales o la forma "{env:VARIABLE}" que usa OpenCode.
function resolveKey(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined
  const env = raw.match(/^\{env:([^}]+)\}$/)
  if (env) return globalThis.process?.env?.[env[1]] || undefined
  if (raw.includes("${")) return undefined
  return raw
}

async function fetchModels(baseURL: string, apiKey?: string): Promise<any[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(baseURL.replace(/\/+$/, "") + "/models", { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json: any = await res.json()
    const list = Array.isArray(json) ? json : (json?.data ?? json?.models ?? [])
    return Array.isArray(list) ? list : []
  } finally {
    clearTimeout(timer)
  }
}

function configEntry(m: any): any {
  const id = typeof m === "string" ? m : m?.id
  const entry: any = {
    name: typeof m?.name === "string" && m.name ? m.name : id,
    limit: { context: 200000, output: 32768 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
  }
  if (typeof m?.context_window === "number" && m.context_window > 0) {
    entry.limit.context = m.context_window
  }
  if (typeof m?.max_output_tokens === "number" && m.max_output_tokens > 0) {
    entry.limit.output = m.max_output_tokens
  }
  if (m?.vision === true) entry.capabilities.input = ["text", "image"]
  return entry
}

// Cementerio: providerID -> modelID -> entrada intacta tal como estaba
// en el jsonc. Se fusiona entre ejecuciones, nunca se sobrescribe.
function graveyardPath(): string {
  return join(configDir(), "pruned-models.json")
}

async function recordPruned(batch: Record<string, Record<string, any>>): Promise<void> {
  const path = graveyardPath()
  let store: any = {}
  try {
    store = parseConfig(await readFile(path, "utf8"))
  } catch {
    // primera vez o archivo corrupto: empezamos de cero pero sin pisar lo leído si se pudo
  }
  for (const [pid, models] of Object.entries(batch)) {
    store[pid] ??= {}
    for (const [mid, entry] of Object.entries(models!)) {
      if (store[pid][mid]) await dbg("graveyard: ya existía entrada para", pid + "/" + mid + ", se conserva la original")
      else store[pid][mid] = entry
    }
  }
  await writeFile(path, JSON.stringify(store, null, 2) + "\n", "utf8")
}

async function pruneFile(): Promise<void> {
  const path = configPath()
  let cfg: any
  try {
    cfg = parseConfig(await readFile(path, "utf8"))
  } catch (e) {
    await dbg("prune: no se pudo leer", String(e))
    return
  }
  const providers = cfg?.providers ?? {}
  const batch: Record<string, Record<string, any>> = {}
  let removedTotal = 0
  const perProvider: string[] = []
  for (const pid of Object.keys(providers)) {
    const p = providers[pid]
    if (typeof p?.package !== "string" || !p.package.includes("openai-compatible")) continue
    const baseURL = p?.settings?.baseURL
    if (typeof baseURL !== "string" || !baseURL) continue
    const models = p?.models
    if (!models || typeof models !== "object" || Object.keys(models).length === 0) continue
    // Seguridad: solo podamos si el gateway respondió OK. Un fallo de
    // red/auth nunca cuenta como "el proveedor sacó el modelo".
    let raw: any[]
    try {
      raw = await fetchModels(baseURL, resolveKey(p?.settings?.apiKey))
    } catch (e) {
      await dbg("prune:", pid, "fetch FALLO, no se poda este provider:", String(e))
      continue
    }
    const live = new Set<string>()
    for (const m of raw) {
      const id = typeof m === "string" ? m : m?.id
      if (typeof id === "string" && id) live.add(id)
    }
    const removed: Record<string, any> = {}
    for (const [mid, entry] of Object.entries(models)) {
      if (live.has(mid)) continue
      removed[mid] = entry
      delete models[mid]
    }
    const n = Object.keys(removed).length
    if (n > 0) {
      removedTotal += n
      batch[pid] = removed
      perProvider.push(`${pid}-${n}`)
    }
  }
  if (removedTotal === 0) {
    await dbg("prune: sin cambios")
    return
  }
  try {
    await recordPruned(batch)
    await copyFile(path, path + BACKUP_SUFFIX)
    await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", "utf8")
    await dbg("prune: eliminados", removedTotal, perProvider.join(" "), "->", graveyardPath())
  } catch (e) {
    await dbg("prune: no se pudo escribir", String(e))
  }
}

async function syncFile(): Promise<void> {
  const path = configPath()
  let cfg: any
  try {
    cfg = parseConfig(await readFile(path, "utf8"))
  } catch (e) {
    await dbg("jsonc: no se pudo leer", String(e))
    return
  }
  const providers = cfg?.providers ?? {}
  let addedTotal = 0
  const perProvider: string[] = []
  for (const pid of Object.keys(providers)) {
    const p = providers[pid]
    if (typeof p?.package !== "string" || !p.package.includes("openai-compatible")) continue
    const baseURL = p?.settings?.baseURL
    if (typeof baseURL !== "string" || !baseURL) continue
    let raw: any[]
    try {
      raw = await fetchModels(baseURL, resolveKey(p?.settings?.apiKey))
    } catch (e) {
      await dbg("jsonc:", pid, "fetch FALLO:", String(e))
      continue
    }
    p.models ??= {}
    let added = 0
    for (const m of raw) {
      const id = typeof m === "string" ? m : m?.id
      if (typeof id !== "string" || !id || p.models[id]) continue
      p.models[id] = configEntry(m)
      added++
    }
    if (added > 0) {
      addedTotal += added
      perProvider.push(`${pid}+${added}`)
    }
  }
  if (addedTotal === 0) {
    await dbg("jsonc: sin cambios")
    return
  }
  try {
    await copyFile(path, path + BACKUP_SUFFIX)
    await writeFile(path, JSON.stringify(cfg, null, 2) + "\n", "utf8")
    await dbg("jsonc: añadidos", addedTotal, perProvider.join(" "))
  } catch (e) {
    await dbg("jsonc: no se pudo escribir", String(e))
  }
}

export default Plugin.define({
  id: "auto-models",
  async setup(ctx) {
    await dbg("=== setup ===")

    const run = async () => {
      await syncFile()
      await ctx.provider.reload().catch(() => {})
    }

    const commandReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "sync-models",
        description: "Sondea los gateways y añade modelos nuevos al jsonc",
        execute: async () => {
          await run()
          await dbg("sync-models manual ejecutado")
        },
      })
      editor.add({
        name: "prune-models",
        description: "Elimina del jsonc los modelos que ya no expone el gateway (los archiva en pruned-models.json)",
        execute: async () => {
          await pruneFile()
          await ctx.provider.reload().catch(() => {})
          await dbg("prune-models manual ejecutado")
        },
      })
    })

    await run()
    const timer = setInterval(() => void run().catch((e) => void dbg("intervalo FALLO:", String(e))), INTERVAL_MS)

    return () => {
      clearInterval(timer)
      void commandReg.dispose()
    }
  },
})
