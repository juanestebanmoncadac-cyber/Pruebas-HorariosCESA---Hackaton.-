/**
 * POST /api/agente — puente entre el navegador y un modelo de lenguaje abierto.
 *
 * Solo guarda la llave y el mensaje de sistema; las herramientas se ejecutan
 * en el navegador (src/agente/). Funciona con cualquier API compatible con
 * OpenAI:
 *   - OpenRouter (por defecto): DeepSeek, Kimi, Qwen, Gemma…
 *   - Ollama local: LLM_BASE_URL=http://localhost:11434/v1, sin llave.
 *
 * Variables de entorno: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL.
 */

const BASE_POR_DEFECTO = 'https://openrouter.ai/api/v1';
const MODELO_POR_DEFECTO = 'deepseek/deepseek-chat';
const MAX_BYTES = 120_000;
const MAX_MENSAJES = 40;
const MAX_HERRAMIENTAS = 8;
const ROLES = new Set(['user', 'assistant', 'tool']);

const SISTEMA = `Eres el asistente de HorarioCESA, que ayuda a estudiantes del CESA (Colegio de Estudios Superiores de Administración, Bogotá) a armar su horario de clases.

Cómo trabajas:
- Tú NO armas horarios. Los arma el motor con la herramienta generar_horarios, que garantiza cero cruces. Nunca inventes horarios, NRC, materias ni profesores: usa solo los datos del contexto y de las herramientas.
- Traduce lo que dice el estudiante en cambios con las herramientas y luego llama generar_horarios.
- Distingue reglas duras de gustos:
  · "no puedo", "trabajo", "tengo práctica" → reglas duras: horaMinima o diasBloqueados.
  · "prefiero", "me gustaría", "odio madrugar" → gustos: ranking o toleranciaHuecos.
- Criterios del ranking: profesores (tener profes preferidos), huecos (días compactos), noMadrugar, diasLibres, terminarTemprano. El primero manda; los demás desempatan.
- Días: Lun, Mar, Mie, Jue, Vie, Sab. diasBloqueados es la lista COMPLETA (incluye los que ya estaban si se mantienen).
- Si una materia queda fuera, explica por qué con los avisos y métricas, y sugiere qué podría ceder el estudiante.
- Más de 21 créditos es sobrecupo: depende del promedio y hay que confirmarlo con Registro Académico.
- Si piden algo que no puedes hacer (inscribir de verdad, ver notas, cambiar la oferta), dilo con amabilidad.

Estilo: español de Colombia, cercano y breve (2 a 5 frases). Sin tablas ni markdown pesado. Cuando compares opciones, habla con datos concretos (hora de entrada, huecos, días libres, profesores).`;

function json(datos: unknown, status = 200): Response {
  return new Response(JSON.stringify(datos), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function esLocal(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1';
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<Response> {
  const env = process.env;
  const base = (env.LLM_BASE_URL || BASE_POR_DEFECTO).replace(/\/$/, '');
  const llave = env.LLM_API_KEY;
  if (!llave && !esLocal(base)) return json({ error: 'sin_llave' }, 503);

  const crudo = await request.text();
  if (crudo.length > MAX_BYTES) return json({ error: 'La conversación es demasiado larga. Empieza una nueva.' }, 413);

  let cuerpo: { messages?: unknown; contexto?: unknown; tools?: unknown };
  try {
    cuerpo = JSON.parse(crudo);
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  const { messages, contexto, tools } = cuerpo;
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MENSAJES) return json({ error: 'messages inválido' }, 400);
  if (!messages.every((m) => m && typeof m === 'object' && ROLES.has((m as { role?: string }).role ?? ''))) return json({ error: 'rol inválido' }, 400);
  if (!Array.isArray(tools) || tools.length > MAX_HERRAMIENTAS) return json({ error: 'tools inválido' }, 400);

  const sistema = typeof contexto === 'string' ? `${SISTEMA}\n\nESTADO ACTUAL DEL ESTUDIANTE:\n${contexto}` : SISTEMA;

  let r: Response;
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(llave ? { authorization: `Bearer ${llave}` } : {}),
        'x-title': 'HorarioCESA (pruebas)',
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || MODELO_POR_DEFECTO,
        messages: [{ role: 'system', content: sistema }, ...messages],
        tools,
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: 800,
      }),
    });
  } catch {
    return json({ error: 'No se pudo contactar al modelo.' }, 502);
  }

  const datos = (await r.json().catch(() => null)) as { choices?: { message?: unknown }[]; error?: { message?: string } } | null;
  if (!r.ok || !datos?.choices?.[0]?.message) {
    console.error('agente: respuesta del modelo', r.status, datos?.error?.message);
    return json({ error: 'El modelo no respondió bien. Intenta de nuevo en un momento.' }, 502);
  }
  return json({ message: datos.choices[0].message });
}
