import { describe, expect, it } from 'vitest';
import { OFERTA, reiniciar, sincronizarMaterias, type Estado } from '../estado/estado';
import { conversar, type Mensaje } from './cliente';
import { HERRAMIENTAS, contexto, ejecutarHerramienta } from './herramientas';

const base = (): Estado => ({ ...reiniciar(), paso: 3 });

/** fetch falso: devuelve en orden los mensajes del "modelo" y guarda lo que se le envió */
function modeloFalso(respuestas: Mensaje[], status = 200) {
  const enviados: { messages: Mensaje[]; contexto: string }[] = [];
  const f = (async (_url: string, init?: RequestInit) => {
    enviados.push(JSON.parse(String(init?.body)));
    const message = respuestas.shift();
    return new Response(JSON.stringify(status === 200 ? { message } : { error: 'sin_llave' }), { status });
  }) as typeof fetch;
  return { f, enviados };
}

const llamada = (name: string, args: object, id = name): Mensaje => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

describe('herramientas del agente', () => {
  it('cada herramienta declarada tiene implementación', () => {
    for (const h of HERRAMIENTAS) {
      expect(ejecutarHerramienta(h.function.name, {}, base()).resultado).not.toMatch(/no existe/);
    }
  });

  it('ajusta preferencias y sube criterios al inicio del ranking sin perder los demás', () => {
    const r = ejecutarHerramienta('ajustar_preferencias', { ranking: ['diasLibres'], horaMinima: 9, diasBloqueados: ['Vie', 'Sab'] }, base());
    expect(r.estado.ranking[0]).toBe('diasLibres');
    expect(new Set(r.estado.ranking).size).toBe(5);
    expect(r.estado.horaMinima).toBe(9);
    expect(r.estado.diasBloqueados).toEqual(['Vie', 'Sab']);
    expect(r.cambio).toBeTruthy();
  });

  it('rechaza valores fuera de rango sin tocar el estado', () => {
    const e = base();
    const r = ejecutarHerramienta('ajustar_preferencias', { horaMinima: 3, limiteCreditos: 99, ranking: ['inventado'] }, e);
    expect(r.estado).toBe(e);
    expect(r.resultado).toMatch(/^Error/);
  });

  it('no acepta profesores ni materias inventados', () => {
    const e = base();
    expect(ejecutarHerramienta('opinar_profesor', { profesor: 'Profesor Inventado', opinion: 'evitar' }, e).estado).toBe(e);
    expect(ejecutarHerramienta('cambiar_materia', { materiaId: 'no-existe', accion: 'necesito' }, e).estado).toBe(e);
  });

  it('marca y desmarca un profesor real', () => {
    const profe = OFERTA.grupos.find((g) => g.profesor)!.profesor!;
    const r = ejecutarHerramienta('opinar_profesor', { profesor: profe, opinion: 'evitar' }, base());
    expect(r.estado.profesores[profe]).toBe('evitar');
    const r2 = ejecutarHerramienta('opinar_profesor', { profesor: profe, opinion: 'neutral' }, r.estado);
    expect(r2.estado.profesores[profe]).toBeUndefined();
  });

  it('quita una materia seleccionada', () => {
    const e = base();
    const id = Object.entries(sincronizarMaterias(e)).find(([, m]) => m.sel)![0];
    const r = ejecutarHerramienta('cambiar_materia', { materiaId: id, accion: 'quitar' }, e);
    expect(r.estado.materias[id].sel).toBe(false);
  });

  it('generar_horarios usa el motor y respeta las reglas duras', () => {
    const e = ejecutarHerramienta('ajustar_preferencias', { horaMinima: 9, diasBloqueados: ['Vie', 'Sab'] }, base()).estado;
    const r = ejecutarHerramienta('generar_horarios', {}, e);
    expect(r.estado.paso).toBe(4);
    for (const h of r.estado.opciones) {
      for (const s of h.asignaciones.flatMap((a) => a.grupo.sesiones)) {
        expect(s.inicio).toBeGreaterThanOrEqual(9);
        expect(['Vie', 'Sab']).not.toContain(s.dia);
      }
    }
  });

  it('el contexto incluye materias y profesores reales', () => {
    const e = base();
    const texto = contexto(e);
    const disponibles = Object.keys(sincronizarMaterias(e));
    expect(texto).toMatch(/Materias disponibles/);
    expect(texto).toContain(OFERTA.grupos.find((g) => g.profesor && disponibles.includes(g.materiaId))!.profesor!);
  });
});

describe('ciclo del agente', () => {
  it('ejecuta las herramientas que pide el modelo y devuelve su respuesta final', async () => {
    const { f, enviados } = modeloFalso([
      llamada('ajustar_preferencias', { diasBloqueados: ['Vie', 'Sab'] }),
      llamada('generar_horarios', {}),
      { role: 'assistant', content: 'Listo, tus viernes quedan libres.' },
    ]);
    const t = await conversar([], 'no puedo los viernes', base(), f);
    expect(t.respuesta).toBe('Listo, tus viernes quedan libres.');
    expect(t.estado.diasBloqueados).toContain('Vie');
    expect(t.estado.paso).toBe(4);
    expect(t.cambios.length).toBeGreaterThanOrEqual(2);
    expect(enviados).toHaveLength(3);
    expect(enviados[1].messages.at(-1)?.role).toBe('tool');
  });

  it('si el modelo cambia algo y no genera, el motor corre de todas formas', async () => {
    const { f } = modeloFalso([llamada('ajustar_preferencias', { horaMinima: 8 }), { role: 'assistant', content: 'Hecho.' }]);
    const t = await conversar([], 'no antes de las 8', base(), f);
    expect(t.estado.paso).toBe(4);
    expect(t.cambios.at(-1)).toMatch(/generé/);
  });

  it('argumentos inválidos no rompen el ciclo', async () => {
    const malo: Mensaje = { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'ajustar_preferencias', arguments: '{roto' } }] };
    const { f } = modeloFalso([malo, { role: 'assistant', content: 'Perdón, intento de nuevo.' }]);
    const e = base();
    const t = await conversar([], 'hola', e, f);
    expect(t.estado).toBe(e);
    expect(t.historial.some((m) => m.role === 'tool' && m.content?.startsWith('Error'))).toBe(true);
  });

  it('sin llave avisa con un mensaje claro', async () => {
    const { f } = modeloFalso([], 503);
    await expect(conversar([], 'hola', base(), f)).rejects.toThrow(/no está configurado/);
  });
});
