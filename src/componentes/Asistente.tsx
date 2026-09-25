import { useEffect, useRef, useState } from 'react';
import type { Estado } from '../estado/estado';
import { ErrorAgente, conversar, type Mensaje } from '../agente/cliente';

interface Burbuja {
  rol: 'yo' | 'ia' | 'error';
  texto: string;
  cambios?: string[];
}

const SUGERENCIAS = [
  'No puedo antes de las 9, trabajo en las mañanas',
  'Quiero tener los viernes libres',
  '¿Por qué quedó fuera una materia?',
  'Compárame las opciones',
];

interface Props {
  e: Estado;
  set: (fn: (e: Estado) => Estado) => void;
}

export function Asistente({ e, set }: Props) {
  const [abierto, setAbierto] = useState(false);
  const [burbujas, setBurbujas] = useState<Burbuja[]>([]);
  const [historial, setHistorial] = useState<Mensaje[]>([]);
  const [texto, setTexto] = useState('');
  const [pensando, setPensando] = useState(false);
  const fin = useRef<HTMLDivElement>(null);
  const actual = useRef(e);
  actual.current = e;

  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [burbujas, pensando]);

  const enviar = async (t: string) => {
    const msg = t.trim();
    if (!msg || pensando) return;
    setTexto('');
    setBurbujas((b) => [...b, { rol: 'yo', texto: msg }]);
    setPensando(true);
    try {
      const turno = await conversar(historial, msg, actual.current);
      setHistorial(turno.historial);
      if (turno.estado !== actual.current) set(() => turno.estado);
      setBurbujas((b) => [...b, { rol: 'ia', texto: turno.respuesta, cambios: turno.cambios }]);
    } catch (err) {
      setBurbujas((b) => [...b, { rol: 'error', texto: err instanceof ErrorAgente ? err.message : 'Algo falló. Intenta de nuevo.' }]);
    } finally {
      setPensando(false);
    }
  };

  if (!abierto) {
    return (
      <button type="button" className="asis-fab" onClick={() => setAbierto(true)} aria-label="Abrir asistente de IA">
        ✦ Asistente IA
      </button>
    );
  }

  return (
    <aside className="asis" aria-label="Asistente de IA">
      <div className="asis-head">
        <div>
          <b>Asistente IA</b>
          <span>Cuéntame cómo quieres tu horario</span>
        </div>
        <button type="button" className="asis-x" aria-label="Cerrar asistente" onClick={() => setAbierto(false)}>×</button>
      </div>

      <div className="asis-body" aria-live="polite">
        {!burbujas.length && (
          <div className="asis-vacio">
            <p>Escríbeme en tus palabras lo que puedes y lo que prefieres. Yo ajusto tus preferencias y el motor busca horarios sin cruces.</p>
            <div className="asis-sug">
              {SUGERENCIAS.map((s) => <button key={s} type="button" onClick={() => enviar(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {burbujas.map((b, i) => (
          <div key={i} className={`asis-msg ${b.rol}`}>
            {b.texto}
            {b.cambios && b.cambios.length > 0 && (
              <ul className="asis-cambios">{b.cambios.map((c, j) => <li key={j}>{c}</li>)}</ul>
            )}
          </div>
        ))}
        {pensando && <div className="asis-msg ia pensando">Pensando…</div>}
        <div ref={fin} />
      </div>

      <form className="asis-form" onSubmit={(ev) => { ev.preventDefault(); enviar(texto); }}>
        <input value={texto} onChange={(ev) => setTexto(ev.target.value)} placeholder="Ej.: no quiero huecos largos" aria-label="Mensaje para el asistente" maxLength={500} disabled={pensando} />
        <button type="submit" className="btn" disabled={pensando || !texto.trim()}>Enviar</button>
      </form>
      <small className="asis-nota">La IA solo cambia tus preferencias; los horarios los arma el motor, siempre sin cruces.</small>
    </aside>
  );
}
