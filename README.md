# opencode-auto-models

Plugin de OpenCode que descubre automáticamente los modelos nuevos de tus
gateways OpenAI-compatibles y los añade a tu `opencode.jsonc` global.
Sin tocar archivos a mano: si el proveedor agrega un modelo, aparece solo.

## Qué hace

- Lee cada provider de tu config cuyo `package` sea `@opencode/ai/providers/openai-compatible`.
- Sondea `GET {baseURL}/models` (con Bearer si hay apiKey, acepta la forma `{env:VARIABLE}`).
- Añade al mapa `providers.<id>.models` **solo los IDs nuevos**; nunca borra ni sobrescribe lo tuyo.
- Por modelo nuevo toma `context_window` y `max_output_tokens` del endpoint (si vienen) y activa visión si `vision: true`. Por defecto: 200k contexto / 32k output.
- Corre cada 5 minutos y bajo demanda con el comando `/sync-models`.
- `/prune-models` (manual, nunca automático): elimina del jsonc los modelos que
  el gateway ya no expone (añadidos por sync O escritos a mano). Antes de
  borrarlos los archiva en `~/.config/opencode/pruned-models.json` con la
  entrada intacta tal como estaba en el jsonc — restaurar es copiar y pegar.
  Si un gateway falla (red/auth), ese provider no se poda.
- Hace backup del jsonc antes de escribir (`opencode.jsonc.autosync.backup`).
- El servidor de OpenCode recarga la config sola; los modelos aparecen en `/models` al momento.
- Log de diagnóstico en `~/.config/opencode/auto-models-debug.log`.

## Instalación

### Opción A: npm (recomendado)

Añade el paquete a tu `opencode.jsonc` global (`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "plugins": ["@danwad/opencode-auto-models"]
}
```

o con el CLI:

```sh
opencode plugin add @danwad/opencode-auto-models
```

Reinicia OpenCode y listo.

### Opción B: manual

#### Windows (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

#### Cualquier SO

Copia `src/auto-models.ts` a la carpeta de plugins de OpenCode:

```
~/.config/opencode/plugins/auto-models.ts
```

(En Windows: `C:\Users\<tu-usuario>\.config\opencode\plugins\`.)

Reinicia OpenCode y listo.

## Requisitos

- Config global con providers OpenAI-compatibles, por ejemplo:

```jsonc
{
  "providers": {
    "minarouter": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MI_API_KEY}"
      },
      "models": {
        "algún-modelo": { /* opcional: entra por config, el plugin lo respeta */ }
      }
    }
  }
}
```

- Si un gateway está caído o da error de auth, el plugin lo reintenta en el
  próximo ciclo sin romper nada. Revisa `auto-models-debug.log` si sospechas fallos.

## Notas

- Solo toca el jsonc global (`~/.config/opencode/opencode.jsonc`), no configs de proyecto.
- Convierte el jsonc a JSON estándar al escribir (los comentarios se pierden
  en la primera escritura; siempre deja backup).
- Los toggles de enable/disable de la app de escritorio son independientes:
  si un modelo no aparece pese a estar en la lista, revisa los toggles de
  provider/modelo en la app.
