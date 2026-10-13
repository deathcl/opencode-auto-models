import { Plugin } from "@opencode/plugin"
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// auto-models: sincroniza el opencode.jsonc GLOBAL con tus gateways
// OpenAI-compatibles. Lee providers.<id>.settings.baseURL, pide
// GET {baseURL}/models y añade al mapa providers.<id>.models los IDs
// nuevos sin tocar los existentes. Corre cada 5 minutos y con /sync-models.
// Solo añade, nunca borra: tus límites y claves del jsonc mandan.
//
// Imagen y video: algunos gateways exponen modelos (imagen/video) que NO
// salen en GET /models. Para esos se consultan fuentes extra:
//   - settings.modelsExtraUrl (string o lista), declarable por provider.
//   - Autodetección de NaraRouter: si el host es *.bynara.id, se usa
//     {origin}/api/pricing, que sí lista imagen/video con sus capacidades.
// Con eso /sync-models los añade y /prune-models NO los borra.
//
// /prune-models (manual) elimina los modelos que ya no expone el gateway
// (añadidos por sync O escritos a mano) y los guarda antes en
// pruned-models.json con su entrada intacta del jsonc, para poder
// restaurarlos con copiar y pegar. Si el gateway o una fuente extra falla,
// ese provider no se poda.
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

async function fetchJson(url: string, apiKey?: string): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Fuentes extra por provider: gateways que exponen modelos (imagen/video)
// que NO aparecen en GET /models. Se declaran con settings.modelsExtraUrl
// (string o lista) y, si el host es NaraRouter, se autodetecta /api/pricing.
export function extraModelUrls(p: any, baseURL: string): string[] {
  const urls: string[] = []
  const declared = p?.settings?.modelsExtraUrl ?? p?.modelsExtraUrl
  if (typeof declared === "string" && declared) urls.push(declared)
  else if (Array.isArray(declared)) for (const u of declared) if (typeof u === "string" && u) urls.push(u)
  try {
    const parsed = new URL(baseURL)
    if (/(^|\.)bynara\.id$/i.test(parsed.hostname)) urls.push(parsed.origin + "/api/pricing")
  } catch {
    // baseURL no parseable: sin autodetección
  }
  return [...new Set(urls)]
}

// Registro unificado de un modelo, con las capacidades que sí sabemos
// distinguir: texto, imagen (entrada/salida) y video.
export type ModelInfo = {
  id: string
  name?: string
  context?: number
  output?: number
  vision?: boolean
  image?: boolean
  video?: boolean
}

// Forma OpenAI-compatible: { data: [{ id, name?, context_window?, vision? }] }
function infoFromOpenAI(m: any): ModelInfo | undefined {
  const id = typeof m === "string" ? m : m?.id
  if (typeof id !== "string" || !id) return undefined
  const info: ModelInfo = { id }
  if (typeof m?.name === "string" && m.name) info.name = m.name
  if (typeof m?.context_window === "number" && m.context_window > 0) info.context = m.context_window
  if (typeof m?.max_output_tokens === "number" && m.max_output_tokens > 0) info.output = m.max_output_tokens
  if (m?.vision === true) info.vision = true
  return info
}

// Forma NaraRouter (/api/pricing): alias, display_name, max_context_tokens
// y banderas supports_vision / supports_image_generation / supports_video_generation.
function infoFromPricing(m: any): ModelInfo | undefined {
  const id = typeof m?.alias === "string" && m.alias ? m.alias : typeof m?.id === "string" ? m.id : undefined
  if (!id) return undefined
  const info: ModelInfo = { id }
  if (typeof m?.display_name === "string" && m.display_name) info.name = m.display_name
  else if (typeof m?.name === "string" && m.name) info.name = m.name
  if (typeof m?.max_context_tokens === "number" && m.max_context_tokens > 0) info.context = m.max_context_tokens
  if (m?.supports_vision === true) info.vision = true
  if (m?.supports_image_generation === true) info.image = true
  if (m?.supports_video_generation === true) info.video = true
  return info
}

export function normalizeModels(raw: any): ModelInfo[] {
  const list = Array.isArray(raw) ? raw : (raw?.data ?? raw?.models ?? [])
  if (!Array.isArray(list)) return []
  const out: ModelInfo[] = []
  for (const m of list) {
    const isPricing = !!m && typeof m === "object" && ("alias" in m || "supports_image_generation" in m)
    const info = isPricing ? infoFromPricing(m) : infoFromOpenAI(m)
    if (info) out.push(info)
  }
  return out
}

export function configEntry(info: ModelInfo): any {
  const input = ["text"]
  if (info.vision) input.push("image")
  const output = ["text"]
  if (info.image) output.push("image")
  if (info.video) output.push("video")
  return {
    name: info.name || info.id,
    limit: { context: info.context ?? 200000, output: info.output ?? 32768 },
    capabilities: { tools: true, input, output },
  }
}

// Fusiona dos vistas del mismo modelo: gana el dato del primario y se
// acumulan las capacidades (un modelo puede salir en /models Y en la fuente
// extra, cada una sabiendo cosas distintas).
function mergeInfo(a: ModelInfo, b: ModelInfo): ModelInfo {
  return {
    id: a.id,
    name: a.name ?? b.name,
    context: a.context ?? b.context,
    output: a.output ?? b.output,
    vision: a.vision || b.vision,
    image: a.image || b.image,
    video: a.video || b.video,
  }
}

// Reúne los modelos vivos de un provider: GET /models + fuentes extra.
// "incomplete" = alguna fuente extra falló, así que prune no debe fiarse.
export async function collectModels(
  p: any,
  baseURL: string,
  apiKey?: string,
): Promise<{ models: Map<string, ModelInfo>; incomplete: boolean }> {
  const models = new Map<string, ModelInfo>()
  const primary = await fetchJson(baseURL.replace(/\/+$/, "") + "/models", apiKey)
  for (const info of normalizeModels(primary)) models.set(info.id, info)
  let incomplete = false
  for (const url of extraModelUrls(p, baseURL)) {
    try {
      for (const info of normalizeModels(await fetchJson(url, apiKey))) {
        const previo = models.get(info.id)
        models.set(info.id, previo ? mergeInfo(previo, info) : info)
      }
    } catch (e) {
      incomplete = true
      await dbg("extra:", url, "FALLO (se ignora):", String(e))
    }
  }
  return { models, incomplete }
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

export async function pruneFile(): Promise<void> {
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
    // red/auth nunca cuenta como "el proveedor sacó el modelo". Si una fuente
    // extra (imagen/video) falla, tampoco se poda: borraría modelos que solo
    // viven ahí.
    let collected: { models: Map<string, ModelInfo>; incomplete: boolean }
    try {
      collected = await collectModels(p, baseURL, resolveKey(p?.settings?.apiKey))
    } catch (e) {
      await dbg("prune:", pid, "fetch FALLO, no se poda este provider:", String(e))
      continue
    }
    if (collected.incomplete) {
      await dbg("prune:", pid, "fuente extra FALLO, no se poda este provider")
      continue
    }
    const live = new Set<string>(collected.models.keys())
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

export async function syncFile(): Promise<void> {
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
    let collected: { models: Map<string, ModelInfo>; incomplete: boolean }
    try {
      collected = await collectModels(p, baseURL, resolveKey(p?.settings?.apiKey))
    } catch (e) {
      await dbg("jsonc:", pid, "fetch FALLO:", String(e))
      continue
    }
    p.models ??= {}
    let added = 0
    for (const info of collected.models.values()) {
      if (p.models[info.id]) continue
      p.models[info.id] = configEntry(info)
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
