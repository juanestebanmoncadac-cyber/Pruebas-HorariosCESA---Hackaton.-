/**
 * Ciclo del agente en el navegador: le manda la conversación a `api/agente`
 * (que solo guarda la llave y habla con el modelo), ejecuta aquí las
 * herramientas que el modelo pida y repite hasta que conteste con texto.
 */
import type { Estado } from '../estado/estado';
import { HERRAMIENTAS, conHorarios, contexto, ejecutarHerramienta } from './herramientas';

export interface LlamadaHerramienta {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Mensaje {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LlamadaHerramienta[];
  tool_call_id?: string;
}

export interface Turno {
  historial: Mensaje[];
  estado: Estado;
  respuesta: string;
  cambios: string[];
}

const MAX_RONDAS = 6;
const MAX_MENSAJES = 30;

/** recorta lo más viejo sin dejar respuestas de herramientas huérfanas al inicio */
function recortar(historial: Mensaje[]): Mensaje[] {
  if (historial.length <= MAX_MENSAJES) return historial;
  const corte = historial.findIndex((m, i) => i >= historial.length - MAX_MENSAJES && m.role === 'user');
  return corte === -1 ? historial.slice(-1) : historial.slice(corte);
}

export class ErrorAgente extends Error {}

async function pedir(historial: Mensaje[], e: Estado, f: typeof fetch): Promise<Mensaje> {
  let r: Response;
  try {
    r = await f('/api/agente', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: recortar(historial), contexto: contexto(e), tools: HERRAMIENTAS }),
    });
  } catch {
    throw new ErrorAgente('No me pude conectar con el asistente. Revisa tu conexión.');
  }
  const datos = (await r.json().catch(() => ({}))) as { message?: Mensaje; error?: string };
  if (r.status === 503) throw new ErrorAgente('El asistente no está configurado (falta la llave del modelo). El resto de la app funciona igual.');
  if (!r.ok || !datos.message) throw new ErrorAgente(datos.error ?? 'El asistente no respondió. Intenta de nuevo.');
  return { role: 'assistant', content: datos.message.content ?? null, tool_calls: datos.message.tool_calls?.length ? datos.message.tool_calls : undefined };
}

export async function conversar(historialPrevio: Mensaje[], texto: string, estado: Estado, f: typeof fetch = fetch): Promise<Turno> {
  const historial: Mensaje[] = [...historialPrevio, { role: 'user', content: texto }];
  const cambios: string[] = [];
  let e = estado;
  let pendiente = false; // hubo cambios después de la última vez que se corrió el motor

  for (let ronda = 0; ronda < MAX_RONDAS; ronda++) {
    const msg = await pedir(historial, e, f);
    historial.push(msg);
    if (!msg.tool_calls) {
      if (pendiente) { e = conHorarios(e); cambios.push(`generé ${e.opciones.length} opciones nuevas`); }
      return { historial, estado: e, respuesta: msg.content?.trim() || 'Listo.', cambios };
    }
    for (const llamada of msg.tool_calls) {
      let args: unknown = {};
      let resultado: string;
      try {
        args = llamada.function.arguments ? JSON.parse(llamada.function.arguments) : {};
        const r = ejecutarHerramienta(llamada.function.name, args, e);
        const cambio = r.estado !== e;
        e = r.estado;
        resultado = r.resultado;
        if (r.cambio) cambios.push(r.cambio);
        if (llamada.function.name === 'generar_horarios') pendiente = false;
        else if (cambio) pendiente = true;
      } catch {
        resultado = 'Error: los argumentos no son JSON válido.';
      }
      historial.push({ role: 'tool', tool_call_id: llamada.id, content: resultado });
    }
  }
  if (pendiente) { e = conHorarios(e); cambios.push(`generé ${e.opciones.length} opciones nuevas`); }
  return { historial, estado: e, respuesta: 'Hice los cambios que pude; revisa el horario y dime si quieres ajustar algo más.', cambios };
}
