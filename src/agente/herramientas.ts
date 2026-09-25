/**
 * Herramientas del asistente de IA.
 *
 * El modelo de lenguaje NO arma horarios: solo propone cambios a lo que el
 * estudiante pidió (materias, profesores, preferencias) y le pide al motor
 * de siempre (`generarHorarios`) que busque las opciones. Todo lo que llega
 * del modelo se valida aquí antes de tocar el estado.
 */
import type { Criterio, Dia, Horario, OpinionProfesor, Prioridad, ToleranciaHuecos } from '../types';
import { DIAS } from '../types';
import { CREDITOS_TOPE, OFERTA, PENSUM, preferenciasDe, sincronizarMaterias, solicitudesDe, type Estado } from '../estado/estado';
import { generarHorarios } from '../motor/generarHorarios';
import { ETIQUETA_CRITERIO, NOMBRE_DIA, fmtHora, listaNatural } from '../motor/explicar';
import { cuando, nombreMateria } from '../componentes/formato';

export const CRITERIOS: Criterio[] = ['profesores', 'huecos', 'noMadrugar', 'diasLibres', 'terminarTemprano'];
const TOLERANCIAS: ToleranciaHuecos[] = ['max1', 'hasta2', 'igual'];
const TEXTO_TOLERANCIA: Record<ToleranciaHuecos, string> = { max1: 'máximo 1 h', hasta2: 'hasta 2 h', igual: 'le da igual' };

/** Definiciones en el formato de "tool calling" compatible con OpenAI (DeepSeek, Kimi, Qwen, Gemma vía OpenRouter u Ollama). */
export const HERRAMIENTAS = [
  {
    type: 'function',
    function: {
      name: 'ajustar_preferencias',
      description:
        'Cambia las preferencias del estudiante. Solo envía los campos que cambian. ' +
        'ranking: criterios en orden de importancia; puedes enviar solo los que suben al principio y el resto conserva su orden. ' +
        'horaMinima y diasBloqueados son reglas duras ("no puedo"); el ranking son gustos ("prefiero").',
      parameters: {
        type: 'object',
        properties: {
          ranking: { type: 'array', items: { type: 'string', enum: CRITERIOS } },
          toleranciaHuecos: { type: 'string', enum: TOLERANCIAS },
          horaMinima: { type: 'number', description: 'hora en decimal, de 6 a 12 (8.5 = 8:30)' },
          diasBloqueados: { type: 'array', items: { type: 'string', enum: DIAS }, description: 'lista completa de días en que NO puede' },
          limiteCreditos: { type: 'integer', description: `máximo de créditos, de 1 a ${CREDITOS_TOPE}` },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cambiar_materia',
      description: 'Agrega o quita una materia disponible. "necesito" = obligatoria, "gustaria" = si cabe, "quitar" = no la inscribe.',
      parameters: {
        type: 'object',
        properties: {
          materiaId: { type: 'string', description: 'id exacto de la lista de materias disponibles' },
          accion: { type: 'string', enum: ['necesito', 'gustaria', 'quitar'] },
        },
        required: ['materiaId', 'accion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'opinar_profesor',
      description: 'Marca un profesor como preferido, a evitar o neutral (quita la opinión).',
      parameters: {
        type: 'object',
        properties: {
          profesor: { type: 'string', description: 'nombre exacto como aparece en el contexto' },
          opinion: { type: 'string', enum: ['preferido', 'evitar', 'neutral'] },
        },
        required: ['profesor', 'opinion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generar_horarios',
      description: 'Corre el motor de horarios con el estado actual y devuelve las mejores opciones sin cruces. Úsala después de cambiar algo.',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const;

export interface ResultadoHerramienta {
  estado: Estado;
  /** texto que se le devuelve al modelo */
  resultado: string;
  /** frase corta para mostrarle al estudiante, si hubo un cambio */
  cambio?: string;
}

const PROFESORES = new Set(OFERTA.grupos.map((g) => g.profesor).filter((p): p is string => !!p));
const nombreDe = (id: string) => PENSUM.materias.find((m) => m.id === id)?.nombre ?? id;

function profesoresDe(materiaId: string): string[] {
  return [...new Set(OFERTA.grupos.filter((g) => g.materiaId === materiaId && g.profesor).map((g) => g.profesor!))];
}

function tieneGrupos(materiaId: string): boolean {
  const tipo = PENSUM.materias.find((m) => m.id === materiaId)?.tipo;
  if (tipo === 'sinHorario') return true;
  const enOferta = tipo === 'bienestar' ? 'BIENESTAR' : tipo === 'electivaSH' ? 'ELECTIVA_SH' : materiaId;
  return OFERTA.grupos.some((g) => g.materiaId === enOferta);
}

/** Igual que `generar` en App.tsx: parte del ranking que ve el estudiante, sin ajustes. */
export function conHorarios(e: Estado): Estado {
  const s = { ...e, ajustes: {} };
  const r = generarHorarios({ solicitudes: solicitudesDe(s), oferta: OFERTA, pensum: PENSUM, preferencias: preferenciasDe(s) });
  return { ...s, paso: 4, opciones: r.opciones, avisos: r.avisos, opcion: 0, vistos: r.opciones.map((h) => h.id), ronda: 1 };
}

export function describirHorario(h: Horario): string {
  const m = h.metricas;
  const materias = h.asignaciones.map((a) => `${nombreMateria(a)} (${a.grupo.profesor ? 'Prof. ' + a.grupo.profesor : a.grupo.actividad}; ${cuando(a.grupo)})`);
  return [
    `${m.creditos} créditos`,
    `entrada ${m.entradaMasTemprana === null ? '—' : fmtHora(m.entradaMasTemprana)}`,
    `salida ${m.salidaMasTarde === null ? '—' : fmtHora(m.salidaMasTarde)}`,
    `${m.horasHueco} h de hueco por semana`,
    `días libres: ${m.diasLibres.length ? m.diasLibres.map((d) => NOMBRE_DIA[d]).join(', ') : 'ninguno'}`,
    m.profesPreferidos.total ? `profes preferidos ${m.profesPreferidos.cumplidos} de ${m.profesPreferidos.total}` : '',
    m.profesEvitadosUsados ? `usa ${m.profesEvitadosUsados} profesor(es) a evitar` : '',
    `materias: ${materias.join('; ')}`,
    h.materiasFuera.length ? `quedan fuera: ${h.materiasFuera.map(nombreDe).join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

/** Foto del estado que el modelo recibe en cada turno (solo datos reales: así no inventa materias ni profesores). */
export function contexto(e: Estado): string {
  const lineas: string[] = [];
  lineas.push(`Límite normal de créditos: ${PENSUM.limiteCreditosSemestre} (más es sobrecupo y depende del promedio). Máximo elegido: ${e.creditos.max}.`);
  lineas.push(`Prioridades (de más a menos importante): ${e.ranking.map((c) => `${c} (${ETIQUETA_CRITERIO[c]})`).join(' > ')}.`);
  lineas.push(`Tolerancia a huecos: ${TEXTO_TOLERANCIA[e.toleranciaHuecos]}. No puede antes de: ${fmtHora(e.horaMinima)}. Días en que no puede: ${e.diasBloqueados.map((d) => NOMBRE_DIA[d]).join(', ') || 'ninguno'}.`);
  lineas.push('', 'Materias disponibles (id · nombre · créditos · estado · profesores):');
  for (const [id, m] of Object.entries(sincronizarMaterias(e))) {
    const materia = PENSUM.materias.find((x) => x.id === id);
    if (!materia) continue;
    const estado = !tieneGrupos(id) ? 'sin grupos en la oferta' : m.sel ? (m.prioridad === 'necesito' ? 'NECESITO' : 'ME GUSTARÍA') : 'no seleccionada';
    const profes = profesoresDe(id).map((p) => (e.profesores[p] ? `${p} [${e.profesores[p]}]` : p));
    const extra = materia.tipo === 'bienestar' || materia.tipo === 'electivaSH'
      ? `actividades elegidas: ${m.actividades.join(', ') || 'cualquiera'}`
      : profes.length ? `profesores: ${profes.join(', ')}` : '';
    lineas.push(`- ${id} · ${materia.nombre} · ${materia.creditos} cr · ${estado}${extra ? ' · ' + extra : ''}${m.nrcFijado ? ` · grupo fijado NRC ${m.nrcFijado}` : ''}`);
  }
  if (e.paso === 4 && e.opciones.length) {
    lineas.push('', `Horarios en pantalla (el estudiante está viendo la opción ${e.opcion + 1}):`);
    e.opciones.forEach((h, i) => lineas.push(`Opción ${i + 1}: ${describirHorario(h)}`));
    if (e.avisos.length) lineas.push(`Avisos del motor: ${e.avisos.join(' ')}`);
  }
  return lineas.join('\n');
}

const esNumero = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function ajustarPreferencias(args: Record<string, unknown>, e: Estado): ResultadoHerramienta {
  let s = e;
  const cambios: string[] = [];
  const errores: string[] = [];

  if (args.ranking !== undefined) {
    const pedidos = Array.isArray(args.ranking) ? args.ranking.filter((c): c is Criterio => CRITERIOS.includes(c as Criterio)) : [];
    const primeros = [...new Set(pedidos)];
    if (!primeros.length) errores.push('ranking inválido');
    else {
      const ranking = [...primeros, ...s.ranking.filter((c) => !primeros.includes(c))];
      s = { ...s, ranking };
      cambios.push(`prioridad principal: ${ETIQUETA_CRITERIO[ranking[0]].toLowerCase()}`);
    }
  }
  if (args.toleranciaHuecos !== undefined) {
    const t = args.toleranciaHuecos as ToleranciaHuecos;
    if (!TOLERANCIAS.includes(t)) errores.push('toleranciaHuecos inválida');
    else { s = { ...s, toleranciaHuecos: t }; cambios.push(`huecos: ${TEXTO_TOLERANCIA[t]}`); }
  }
  if (args.horaMinima !== undefined) {
    const h = args.horaMinima;
    if (!esNumero(h) || h < 6 || h > 12) errores.push('horaMinima debe estar entre 6 y 12');
    else { const hm = Math.round(h * 2) / 2; s = { ...s, horaMinima: hm }; cambios.push(`nada antes de las ${fmtHora(hm)}`); }
  }
  if (args.diasBloqueados !== undefined) {
    const dias = Array.isArray(args.diasBloqueados) ? args.diasBloqueados.filter((d): d is Dia => DIAS.includes(d as Dia)) : null;
    if (!dias) errores.push('diasBloqueados inválido');
    else {
      const unicos = DIAS.filter((d) => dias.includes(d));
      s = { ...s, diasBloqueados: unicos };
      cambios.push(unicos.length ? `no puedes: ${listaNatural(unicos.map((d) => NOMBRE_DIA[d]))}` : 'sin días bloqueados');
    }
  }
  if (args.limiteCreditos !== undefined) {
    const c = args.limiteCreditos;
    if (!esNumero(c) || c < 1 || c > CREDITOS_TOPE) errores.push(`limiteCreditos debe estar entre 1 y ${CREDITOS_TOPE}`);
    else { const max = Math.round(c); s = { ...s, creditos: { min: Math.min(s.creditos.min, max), max } }; cambios.push(`máximo ${max} créditos`); }
  }

  if (!cambios.length) return { estado: e, resultado: `Error: no se cambió nada. ${errores.join('; ')}` };
  return {
    estado: s,
    resultado: `Listo: ${cambios.join('; ')}.${errores.length ? ' Ignorado: ' + errores.join('; ') + '.' : ''}`,
    cambio: cambios.join(' · '),
  };
}

function cambiarMateria(args: Record<string, unknown>, e: Estado): ResultadoHerramienta {
  const id = String(args.materiaId ?? '');
  const accion = args.accion as Prioridad | 'quitar';
  const materias = sincronizarMaterias(e);
  if (!materias[id]) return { estado: e, resultado: `Error: "${id}" no es una materia disponible. Usa un id de la lista del contexto.` };
  if (accion !== 'necesito' && accion !== 'gustaria' && accion !== 'quitar') return { estado: e, resultado: 'Error: accion debe ser necesito, gustaria o quitar.' };
  if (accion !== 'quitar' && !tieneGrupos(id)) return { estado: e, resultado: `Error: ${nombreDe(id)} no tiene grupos en la oferta de este periodo.` };
  const m = materias[id];
  const nueva = accion === 'quitar' ? { ...m, sel: false } : { ...m, sel: true, prioridad: accion };
  const texto = accion === 'quitar' ? `quitaste ${nombreDe(id)}` : `${nombreDe(id)}: ${accion === 'necesito' ? 'la necesitas' : 'te gustaría'}`;
  return { estado: { ...e, materias: { ...e.materias, [id]: nueva } }, resultado: `Listo: ${texto}.`, cambio: texto };
}

function opinarProfesor(args: Record<string, unknown>, e: Estado): ResultadoHerramienta {
  const profesor = String(args.profesor ?? '');
  const opinion = args.opinion;
  if (!PROFESORES.has(profesor)) return { estado: e, resultado: `Error: no hay ningún profesor "${profesor}" en la oferta. Usa el nombre exacto del contexto.` };
  if (opinion !== 'preferido' && opinion !== 'evitar' && opinion !== 'neutral') return { estado: e, resultado: 'Error: opinion debe ser preferido, evitar o neutral.' };
  const profesores: Record<string, OpinionProfesor> = { ...e.profesores };
  if (opinion === 'neutral') delete profesores[profesor];
  else profesores[profesor] = opinion;
  const texto = opinion === 'neutral' ? `sin opinión sobre ${profesor}` : `${profesor}: ${opinion === 'preferido' ? '★ preferido' : '✕ evitar'}`;
  return { estado: { ...e, profesores }, resultado: `Listo: ${texto}.`, cambio: texto };
}

export function ejecutarHerramienta(nombre: string, args: unknown, e: Estado): ResultadoHerramienta {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  switch (nombre) {
    case 'ajustar_preferencias': return ajustarPreferencias(a, e);
    case 'cambiar_materia': return cambiarMateria(a, e);
    case 'opinar_profesor': return opinarProfesor(a, e);
    case 'generar_horarios': {
      const s = conHorarios(e);
      if (!s.opciones.length) return { estado: s, resultado: `No hay horarios posibles. Avisos: ${s.avisos.join(' ') || 'ninguno'}`, cambio: 'generé horarios (sin resultados)' };
      const texto = s.opciones.map((h, i) => `Opción ${i + 1}: ${describirHorario(h)}`).join('\n');
      return { estado: s, resultado: `${texto}${s.avisos.length ? '\nAvisos: ' + s.avisos.join(' ') : ''}`, cambio: `generé ${s.opciones.length} opciones nuevas` };
    }
    default: return { estado: e, resultado: `Error: la herramienta "${nombre}" no existe.` };
  }
}
