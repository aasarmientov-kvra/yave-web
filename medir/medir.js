/* YAVE · página de medición de la fase 0.
   Mide cuánto tarda la nube en responder desde este equipo, región por región,
   y manda el resultado a los proyectos de prueba para que Claude lo lea. */
(function () {
  const cfg = window.MEDIR || null;
  const $ = id => document.getElementById(id);
  const eleccion = { equipo: 'Celular de portería', conexion: 'Wifi del taller' };
  let ultimoResultado = null;

  function avisar(texto) {
    $('aviso').textContent = texto;
    $('aviso').hidden = false;
    $('medir').disabled = true;
  }

  if (!window.supabase || !window.supabase.createClient) {
    avisar('No cargó la conexión con la nube en este equipo. Recarga la página; si sigue igual, mándale a Claude una captura de esta pantalla.');
    return;
  }
  if (!cfg || !Array.isArray(cfg.proyectos) || !cfg.proyectos.length) {
    avisar('Esta página todavía no está conectada a la nube. Claude la conecta cuando estén creadas las cuentas.');
    return;
  }

  document.querySelectorAll('.opciones').forEach(grupo => {
    grupo.addEventListener('click', ev => {
      const b = ev.target.closest('button');
      if (!b) return;
      grupo.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      eleccion[grupo.dataset.campo] = b.dataset.valor;
    });
  });

  const muestras = cfg.muestras || 20;
  const esperaMax = cfg.esperaMaxMs || 10000;

  function cliente(p) {
    return window.supabase.createClient(p.url, p.llave, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }

  /** Una llamada a ping con tiempo máximo. Devuelve milisegundos o un error, nunca espera para siempre. */
  async function unaLlamada(c) {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), esperaMax);
    const t0 = performance.now();
    try {
      const { error } = await c.rpc('ping').abortSignal(ctrl.signal);
      const ms = Math.round(performance.now() - t0);
      return error ? { error: ctrl.signal.aborted ? 'pasó el tiempo máximo' : (error.message || 'error') } : { ms };
    } catch (e) {
      return { error: ctrl.signal.aborted ? 'pasó el tiempo máximo' : String(e && e.message || e) };
    } finally {
      clearTimeout(reloj);
    }
  }

  /** Lo que ve la persona; el error exacto viaja en los datos para Claude. */
  function enPalabras(error) {
    if (!error) return 'no hubo conexión con la nube';
    if (error === 'pasó el tiempo máximo') return 'la nube tardó más de ' + Math.round(esperaMax / 1000) + ' segundos en contestar';
    if (/fetch|network|load failed|conexi/i.test(error)) return 'no hubo conexión con la nube';
    return 'la nube contestó con un error';
  }

  const ordenar = v => v.slice().sort((a, b) => a - b);
  const percentil = (v, p) => v.length ? ordenar(v)[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)] : null;

  function tarjeta(p) {
    const el = document.createElement('div');
    el.className = 'region';
    el.innerHTML = '<h2></h2><div class="barra"><span></span></div><p class="cifra">…</p><p class="detalle">Esperando turno</p>';
    el.querySelector('h2').textContent = p.nombre;
    $('regiones').appendChild(el);
    return {
      avance: f => { el.querySelector('.barra span').style.transform = 'scaleX(' + f + ')'; },
      cifra: (t, mal) => { const c = el.querySelector('.cifra'); c.textContent = t; c.classList.toggle('mal', !!mal); },
      detalle: t => { el.querySelector('.detalle').textContent = t; },
    };
  }

  async function medirRegion(p, vista) {
    const c = cliente(p);
    vista.detalle('Midiendo…');
    const primera = await unaLlamada(c);
    await unaLlamada(c);
    const tiempos = [];
    const errores = [];
    for (let i = 0; i < muestras; i++) {
      const r = await unaLlamada(c);
      if (r.ms != null) tiempos.push(r.ms); else errores.push(r.error);
      vista.avance((i + 1) / muestras);
    }
    const res = {
      region: p.region, nombre: p.nombre,
      primera_ms: primera.ms != null ? primera.ms : null, primera_error: primera.error || null,
      mediana_ms: percentil(tiempos, 0.5), p90_ms: percentil(tiempos, 0.9),
      min_ms: tiempos.length ? Math.min(...tiempos) : null, max_ms: tiempos.length ? Math.max(...tiempos) : null,
      fallas: errores.length, errores: errores.slice(0, 5), muestras: tiempos,
    };
    if (res.mediana_ms == null) {
      vista.cifra('Sin respuesta', true);
      vista.detalle('No respondió ninguna de las ' + muestras + ' pruebas: ' + enPalabras(errores[0]) + '.');
    } else {
      vista.cifra(res.mediana_ms + ' ms');
      vista.detalle('Respuesta típica. 9 de cada 10 en menos de ' + res.p90_ms + ' ms' + (res.fallas ? '; ' + res.fallas + ' de ' + muestras + ' no respondieron.' : '.'));
    }
    return res;
  }

  async function enviar(datos) {
    const envios = await Promise.all(cfg.proyectos.map(async p => {
      const ctrl = new AbortController();
      const reloj = setTimeout(() => ctrl.abort(), esperaMax);
      try {
        const { error } = await cliente(p).rpc('f0_registrar_latencia', { datos }).abortSignal(ctrl.signal);
        return !error;
      } catch (e) {
        return false;
      } finally {
        clearTimeout(reloj);
      }
    }));
    return envios.some(Boolean);
  }

  function mostrarFinal(ok) {
    $('final').hidden = false;
    $('finalTexto').className = ok ? '' : 'mal';
    $('finalTexto').textContent = ok
      ? 'Listo. Los resultados ya le llegaron a Claude; no tienes que hacer nada más.'
      : 'No se pudieron enviar los resultados: se cayó la conexión. Toca «Volver a enviar» o mándale a Claude una captura de esta pantalla.';
    $('reenviar').hidden = ok;
  }

  async function medir() {
    $('medir').disabled = true;
    $('final').hidden = true;
    $('regiones').innerHTML = '';
    const vistas = cfg.proyectos.map(tarjeta);
    const regiones = [];
    for (let i = 0; i < cfg.proyectos.length; i++) regiones.push(await medirRegion(cfg.proyectos[i], vistas[i]));
    const red = navigator.connection ? { tipo: navigator.connection.effectiveType || null, bajada_mbps: navigator.connection.downlink || null, rtt_ms: navigator.connection.rtt || null } : null;
    ultimoResultado = { fecha: new Date().toISOString(), equipo: eleccion.equipo, conexion: eleccion.conexion, navegador: navigator.userAgent, red, muestras, espera_max_ms: esperaMax, regiones };
    mostrarFinal(await enviar(ultimoResultado));
    $('medir').disabled = false;
  }

  $('medir').addEventListener('click', medir);
  $('otraVez').addEventListener('click', medir);
  $('reenviar').addEventListener('click', async () => {
    $('reenviar').disabled = true;
    mostrarFinal(await enviar(ultimoResultado));
    $('reenviar').disabled = false;
  });
})();
