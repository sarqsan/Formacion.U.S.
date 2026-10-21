# Informe de la fase 5 — viabilidad real a coste cero

**Fecha:** 21 de octubre de 2026
**Rama:** `arena/89a0aca0-formacion-u-s` (base `c4ce33d`, sin commits)
**Alcance:** análisis y documentación. **No se ha implementado nada, no se ha
creado ninguna cuenta, no se ha desplegado y no se ha tocado la aplicación
antigua.**
**Datos externos consultados:** 21/10/2026. Las cuotas de un proveedor cambian
sin avisar; cada cifra lleva su fuente y conviene reconfirmarla antes de firmar
el diseño definitivo.

---

## Veredicto

> **Viable con limitaciones.** La aplicación puede funcionar de extremo a
> extremo sin coste obligatorio, pero **no con la arquitectura tal y como está
> hoy**: hay un defecto que la haría fallar con PDF de más de ~9 MiB, y hay
> cuatro carencias de seguridad/operación que deben cerrarse antes de usar
> datos reales. Ninguna exige pagar; todas exigen trabajo.

Condiciones para que el "sí" se sostenga:

| # | Condición | Estado hoy |
| --- | --- | --- |
| 1 | **Corregir el tamaño de transacción** de la subida de PDF (máx. 10 MiB por petición) | **Defecto abierto**: se escribe hasta 20 MiB en una transacción |
| 2 | **Alojar el servidor** en una máquina propia o en un plan gratuito que permita uso comercial | **Sin decidir** (Vercel Hobby queda descartado por sus términos) |
| 3 | **Aceptar que no hay copias gestionadas**: exportación manual y restauración *probada* | **No existe** ni el script ni la prueba |
| 4 | **Implementar matriculación, límite de peticiones y lectura secuencial** en el servidor | **No implementado** (solo modelado) |
| 5 | Corpus de PDF ≤ ~512 MiB y comprimido | **Desconocido** (no hay PDF reales) |
| 6 | Ejecutar las 36 pruebas de reglas antes de datos reales | **0 ejecutadas** (sin JVM) |

Lo que **sí** está resuelto: no hace falta Blaze, no hace falta tarjeta, no hace
falta Cloud Storage, no hay enlaces públicos a PDF y el coste de Firebase es
cero mientras no se superen las cuotas gratuitas.

---

## 1. Método

1. Inspección del código real, no del informe: endpoints existentes, reglas,
   dominio de lectura, configuración y dependencias.
2. Contraste de las cifras de la fase 4 con la documentación vigente de Google
   (cuotas de Firestore, límites de transacción, disponibilidad por plan).
3. Revisión de los planes gratuitos de alojamiento **con sus términos de uso**,
   no solo con sus tablas de límites.
4. Cálculo del consumo esperado con los números del propio código
   (768 KiB por fragmento, 20 MiB por PDF, presupuesto 512 MiB).

**Aviso de honestidad:** el emulador de Firebase sigue sin poder arrancar en
este entorno (no hay JVM) y no hay proyecto Firebase. Todo lo que sigue son
límites documentados y razonamiento sobre el código; **no** mediciones. Cada
afirmación no verificada se marca como tal.

---

## 2. Alojamiento del servidor Next.js

### 2.1 Qué exige esta aplicación a un host

No es una web estática. Necesita:

- **Proceso Node.js** (runtime `nodejs`, no `edge`) en **cada** Route Handler:
  `firebase-admin` no funciona en el runtime edge de Next.
- **Salida a internet** hacia `*.googleapis.com` (Firestore, Identity Toolkit).
- **Cookies httpOnly + `Secure`** → el host debe servir **HTTPS** (todos los
  candidatos lo hacen).
- **Memoria suficiente** para Node + `firebase-admin` + una respuesta de hasta
  768 KiB: 512 MB es el mínimo razonable.
- **Sin límite de CPU por petición** pequeño: verificar la sesión y leer
  Firestore cuesta CPU; un tope de 10 ms por petición es incompatible.
- **Ancho de banda**: los PDF salen **por el servidor** (no hay Storage), así
  que el tráfico de PDF cuenta en el host *y* en Firebase a la vez.

### 2.2 Comparativa (planes gratuitos, consultados 21/10/2026)

| Plataforma | ¿Gratis de verdad? | Límites relevantes | Veredicto para Formación |
| --- | --- | --- | --- |
| **Servidor propio** (máquina de la organización, Caddy/Nginx + systemd) | Sí, si el hardware ya existe | Ninguno de plataforma; los límites son de Firebase | **Recomendado** |
| **Vercel Hobby** | Sí, pero **solo uso personal no comercial** | 100 GB tráfico, 1 M invocaciones; *Prohibido uso comercial* | **Descartado por términos** |
| **Netlify Free** | Sí, permite uso comercial | **300 créditos/mes** (20/GB tráfico, 15 por deploy, 10/GB-h de cómputo); sin tarjeta | **Aceptable para piloto**, justo para producción |
| **Render Hobby** | Sí | 512 MB / 0.1 CPU, 750 h/mes, **se duerme a los 15 min** (~1 min de arranque), **5 GB/mes de tráfico**, "no para producción" | **Solo pruebas** |
| **Cloudflare Workers/Pages Free** | Sí | 100 k peticiones/día, **10 ms de CPU**, **128 MB**, sin APIs de Node | **No viable** sin reescribir la capa de datos |
| **Firebase Hosting** | Sí (10 GB, 360 MB/día) | **Solo estático**: no ejecuta servidor | **No sirve** |
| **Firebase App Hosting / Cloud Functions** | No | Requiere **Blaze** | **Descartado** |
| Google Cloud Run | Cuota gratuita amplia | **Exige cuenta de facturación** (aunque no se cobre) | **Descartado** (contra la orden) |
| Oracle/otros "Always Free" | Sí | Suelen pedir tarjeta de verificación | **Descartado** |

### 2.3 El detalle que descarta Vercel

Los términos de Vercel son explícitos: el plan Hobby es **solo para uso personal
o no comercial**, y consideran comercial cualquier despliegue que sirva al
beneficio económico de alguien implicado en el proyecto, **incluido un empleado
o consultor que escriba el código**. Un curso interno obligatorio para el
personal de una empresa encaja en esa definición. No es una cuestión de tráfico
(2 GB al mes también incumpliría): es una **regla de elegibilidad**. El plan
profesional cuesta 20 $ por asiento al mes.

**Consecuencia:** usar Vercel Hobby sería incumplir el contrato y arriesgar la
suspensión del proyecto sin aviso. No lo propongo ni como piloto.

### 2.4 Netlify Free: sí, pero con un presupuesto de 300 créditos

Es la única plataforma grande que **permite uso comercial** en su plan gratuito
y no pide tarjeta. Pero desde septiembre de 2025 el plan es de **créditos**:

| Acción | Créditos |
| --- | --- |
| Deploy de producción | 15 |
| 1 GB de tráfico | 20 |
| 1 GB-hora de cómputo | 10 |
| 10 000 peticiones web | 2 |

Con 300 créditos al mes: ~20 deploys **o** ~15 GB de tráfico **o** ~30 GB-h de
cómputo, y lo que se gaste se reparte entre todo. Si se agota, **el sitio se
suspende hasta el mes siguiente**. Traducido: unos 5 deploys al mes (75
créditos) dejan ~11 GB de tráfico. Para 50 alumnos que lean PDF de 1 MiB
comprimido, es suficiente; para 200 alumnos con PDF grandes, no.

### 2.5 Render free: no es producción

Render es honesto en su propia documentación: **los servicios gratuitos no son
para producción**. Se duermen a los 15 minutos sin tráfico y tardan ~1 minuto en
despertar (el usuario ve una pantalla de carga), tienen 512 MB, 0.1 CPU y, desde
abril de 2026, **5 GB de tráfico al mes** — menos que los 10 GiB de Firestore, así
que el host sería el cuello de botella. Sirve para validar el flujo con datos de
prueba, no para el curso real.

### 2.6 Cloudflare: el runtime no es Node

Workers ejecuta V8 isolates con **128 MB**, **10 ms de CPU por petición** y sin
APIs de Node (sin `net`, sin gRPC, sin sistema de ficheros). `firebase-admin`
está pensado para Node; habría que forzar transporte REST y aun así el límite de
CPU y memoria es incompatible con arrancar el SDK. **No es una opción sin
reescribir la capa de datos**, y eso contradice la orden de no rehacer lo que
funciona.

### 2.7 Hosting recomendado

**Servidor propio de la organización**, si existe una máquina (física o virtual)
que ya esté encendida: coste marginal cero, sin términos de terceros, sin
límite de tráfico, y los PDF no salen de la infraestructura propia salvo hacia
Google. Es además lo más coherente con un curso interno: puede quedarse **en la
red interna o detrás de VPN**, sin exposición a internet, con HTTPS de Caddy.

Requisitos concretos: Node 22, 1 GB de RAM, 5 GB de disco para el despliegue y
las exportaciones, salida HTTPS a `*.googleapis.com`, copia de seguridad del
`.env` y de las exportaciones **fuera** de la máquina.

Si no hay máquina: **Netlify Free** para un piloto con pocos alumnos, asumiendo
el techo de 300 créditos y midiendo desde el primer día.

---

## 3. Firebase Spark: qué está disponible y qué obligaría a pagar

### 3.1 Operaciones que usa el proyecto

| Operación | ¿En Spark? | Consumo que genera |
| --- | --- | --- |
| Auth con correo/contraseña | **Sí** (50 000 usuarios activos/mes) | No cuenta en Firestore |
| Custom Claims (`role`, `status`, `claimsVersion`) | **Sí** | Gratis |
| `createSessionCookie` / `verifyIdToken` (Admin SDK) | **Sí** | 1 verificación por petición (tráfico de Auth, no lecturas) |
| Lectura del documento de cuenta en cada petición | **Sí** | 1 lectura |
| Lecturas/escrituras de Firestore (progreso, intentos, cursos) | **Sí** | 50 000 / 20 000 al día |
| Consultas con índice compuesto | **Sí** | 1 lectura por documento devuelto |
| Reglas de seguridad | **Sí** | Evaluación gratuita (con límite de 10/20 `get()` por petición) |
| Índices compuestos (crearlos) | **Sí** | Gratis; sus entradas **cuentan** en el 1 GiB |
| Fragmentos `Bytes` en Firestore (PDF) | **Sí** | 1 escritura/lectura por fragmento |
| Transacciones | **Sí** | Límite de **10 MiB por petición** (ver §4) |
| **Cloud Storage** | **No** — requiere Blaze desde el 3/2/2026 | — |
| **Cloud Functions / App Hosting** | **No** — requieren Blaze | — |
| **Export/import gestionado, backups, PITR** | **No** — exigen facturación | — |
| **TTL de Firestore** (borrado automático) | **No** — figura como función sin cuota gratuita | — |

### 3.2 Qué pasa al agotar una cuota

Esto es lo importante para un proyecto **sin** facturación:

- **No hay cargo posible**: en Spark no hay instrumento de pago; no puede
  aparecer una factura ni un upgrade automático.
- Al superar una cuota **diaria** (lecturas, escrituras), Firestore devuelve
  errores de cuota hasta el reinicio (~medianoche hora del Pacífico).
  Consecuencia práctica: **la aplicación deja de funcionar para todos**,
  incluido el inicio de sesión, porque cada sesión lee la ficha de cuenta.
- Al superar una cuota **mensual** (10 GiB de salida), la documentación de planes
  indica que **el producto se apaga para el resto del mes** en ese proyecto.
- Riesgo real: esto **no es solo un problema de factura**, es una **parada del
  servicio**. Ninguna cuota de Spark protege de un uso anómalo más que el propio
  código (ver §6).

### 3.3 Cálculo de consumo (con los números del código)

| Escenario | Lecturas/día | Escrituras/día | Salida/mes |
| --- | --- | --- | --- |
| 50 alumnos × 10 peticiones autenticadas | ~500–1 000 | ~50 | despreciable |
| + 10 PDF de 5 MiB leídos por 50 alumnos | 10 × 7 × 50 = **3 500** | 0 | **2,5 GiB** |
| + 100 PDF de 5 MiB leídos por 50 alumnos | 35 000 | — | **25 GiB → supera el mes** |

Conclusión: **las lecturas aguantan; la salida de red es el límite real**. Con
PDF de 5 MiB, 10 GiB/mes son ~2 000 lecturas completas. Ese es el número que hay
que vigilar, y el motivo por el que comprimir los PDF no es cosmética: un PDF de
5 MiB comprimido a 1 MiB multiplica por cinco la capacidad.

---

## 4. PDF: límites reales y un defecto encontrado

### 4.1 Límites oficiales (verificados en la documentación)

| Límite | Valor | Fuente |
| --- | --- | --- |
| Tamaño máximo de un documento | 1 048 576 B (1 MiB) | Firestore: cuotas |
| Tamaño máximo de petición/transacción | **10 MiB** | Firestore: cuotas |
| Escrituras por transacción | el límite de 500 **se retiró en marzo de 2023** | notas de versión |
| Duración máxima de una transacción | 270 s | Firestore: cuotas |
| Escrituras sostenidas a un mismo documento | ~1/s | Firestore: cuotas |
| `get()`/`exists()` por petición en reglas | 10 (20 en transacciones) | Firestore: cuotas |
| Cuota de datos almacenados | 1 GiB | Spark |

### 4.2 El defecto: 20 MiB no caben en una transacción

La fase 4 concluyó que "29 escrituras están muy por debajo de las 500". Es
cierto, pero **irrelevante**: el límite que muerde es el de **10 MiB por
petición**, y 27 fragmentos de 768 KiB son **20,25 MiB**.

- Firestore acepta 13 fragmentos por transacción (9,98 MiB) como máximo
  absoluto, y eso sin margen para metadatos.
- Con 768 KiB por fragmento, el máximo seguro dentro de una transacción es
  **~9 MiB de PDF** (12 fragmentos = 9,0 MiB).
- El código actual (`MAX_PDF_BYTES = 20 MiB`) **sube un PDF de 20 MiB en una
  sola transacción**: fallaría con error de petición demasiado grande.

**Por qué no se detectó antes:** ninguna prueba lo cubre. Los dobles en memoria
no tienen límite de tamaño, y la prueba contra Firestore real está bloqueada
(§7). Es el ejemplo perfecto de lo que se pierde sin emulador: un fallo de
diseño en el camino principal de subida.

**Dos salidas, ninguna implementada aún:**

| Opción | Ventaja | Coste |
| --- | --- | --- |
| **A. Bajar el tope a 8 MiB** (11 fragmentos) | Cambio pequeño, sigue siendo una transacción atómica | PDF grandes hay que partirlos en varios documentos o comprimirlos |
| **B. Subida en dos fases** (`pending` → escribir por lotes de 12 → `ready`) | Admite 20 MiB | Deja de ser atómica: hay que limpiar restos, y el contador de cuota necesita compensación |

Recomiendo **A** ahora (es un cambio de una constante y de la validación) y **B**
solo si aparecen PDF reales que no quepan.

### 4.3 ¿Es viable guardar los fragmentos como `Bytes`?

**Sí, con matices:**

- **Oficial y seguro:** 768 KiB es un 25 % menor que el límite de 1 MiB, y
  `Bytes` almacena el binario tal cual (no base64). La fase 4 dejó esto
  argumentado y con una prueba que fija la relación 768 KiB ↔ 1 MiB en base64.
- **No medido:** nadie ha escrito todavía 768 KiB en un documento real de
  Firestore. La deducción es sólida (el límite es del documento completo, no de
  un tipo de dato), pero **es una deducción**.
- **Índices:** Firestore indexa los campos por defecto. Un `Bytes` de 768 KiB no
  aporta nada al índice y consume espacio de la cuota de 1 GiB. **Recomendación
  a verificar:** excluir `pdfChunks.data` de la indexación con un
  `fieldOverride` (Firestore permite hasta **200 configuraciones de un solo
  campo sin facturación**). No está hecho.
- **Coste de lectura:** una ventana = 1 lectura por fragmento. Un PDF de 5 MiB
  leído entero = 7 lecturas.

### 4.4 Presupuesto de 512 MiB

Coherente: 1 GiB total, 512 MiB para PDF, 128 MiB de reserva explícita para el
resto, 896 MiB como techo configurable. Con el tope de 8 MiB por PDF (opción A),
caben **64 PDF** en 512 MiB; con 20 MiB, 25. La diferencia es un argumento más
para comprimir: un PDF de 5 MiB que se comprime a 1 MiB pasa de 102 a 512
documentos.

**Dato que falta:** el tamaño real del corpus. Sin él, "512 MiB bastan" es una
hipótesis, no un hecho.

---

## 5. Copias de seguridad sin coste obligatorio

### 5.1 Lo que **no** se puede usar en Spark (verificado)

- Export/import gestionado de Firestore: **requiere Blaze y un bucket**.
- Copias programadas y restauración gestionada: **requieren Blaze**.
- PITR (ventana de 7 días): **requiere facturación** y no tiene cuota gratuita.
- TTL para borrar tokens caducados automáticamente: figura entre las funciones
  **sin cuota gratuita**.

Es decir: **en Spark no existe ninguna copia de seguridad nativa**. Cualquier
alternativa es artesanal.

### 5.2 Alternativa propuesta (gratuita, con riesgos)

**Exportación con el Admin SDK a un fichero JSON por colección**, ejecutada a
mano o desde una tarea programada gratuita (GitHub Actions en repositorio
privado, 2 000 min/mes), guardada en:

1. el disco de la máquina que aloja el servidor, **y**
2. una copia fuera de esa máquina (disco externo o repositorio **privado** con
   los datos cifrados), porque un backup en la misma máquina no es un backup.

Riesgos, sin adornos:

| Riesgo | Detalle |
| --- | --- |
| **No es una foto atómica** | Se lee colección a colección; si alguien responde un cuestionario a mitad, el JSON mezcla estados. Aceptable para este dominio, no para contabilidad |
| **La restauración no está probada** | Un export que nunca se ha restaurado **no es una copia de seguridad**, es una carpeta. Hasta que no se haga un ensayo de restauración en un proyecto desechable, el RTO es desconocido |
| **Contiene datos personales** | Nombres, apellidos, roles, progreso. El fichero debe ir cifrado y con acceso restringido; nada de Drive público ni de repositorio abierto |
| **No protege de un borrado lógico** | Si alguien archiva documentos o resetea claves, la copia es de ayer. La ventana de pérdida es la frecuencia del export |
| **Depende de una persona** | Un proceso manual se olvida. Si se automatiza, la tarea programada y sus credenciales son una superficie más |
| **Los PDF se copian enteros** | Ocupan el 99 % del volumen; conviene exportar metadatos y una copia de los binarios por separado |

**Mitigación barata y muy eficaz:** el contenido didáctico (cursos, temas,
claves) es **regenerable** desde los ficheros originales que administración
guarda; el progreso e intentos son datos derivados. Lo crítico de verdad son las
**cuentas** y los **tokens de activación**: eso es pequeño y se puede exportar a
diario sin coste.

**Criterio de aceptación propuesto** (no implementado): un ensayo de restauración
completo en un proyecto de pruebas, cronometrado y documentado, antes de cargar
datos reales. Mientras no exista ese ensayo, la respuesta honesta es "no tenemos
copias verificadas".

---

## 6. Seguridad: revisión del estado actual

### 6.1 Endpoints de documentos (lo que hay)

`GET /api/documents/{id}/window` comprueba, en orden: sesión válida, cuenta
activa, documento existente y no archivado, versión publicada (salvo admin) y
ventana ≤ 768 KiB. Responde con `no-store`, `nosniff` y sin exponer rutas.
`POST/GET /api/admin/documents` exigen administrador activo y origen de confianza
en las mutaciones.

**Lo que falta, y no es menor:**

| Carencia | Riesgo | Gravedad |
| --- | --- | --- |
| **Sin matriculación** | Cualquier cuenta activa lee ventanas de **cualquier curso publicado**. Un alumno de un curso puede leer los PDF de otro | Alta (funcional y de confidencialidad) |
| **Sin límite de peticiones** | Un usuario puede recorrer las ventanas de un PDF en bucle. Con 50 000 lecturas/día, **≈7 000 descargas completas de un PDF de 5 MiB agotan la cuota diaria y tumban la aplicación entera** hasta medianoche | **Alta: es una denegación de servicio por cuota** |
| **Sin registro de accesos** | No hay forma de saber quién descargó qué ni de detectar el abuso anterior | Media |
| **Lectura secuencial no aplicada** | `assertCanViewPage` existe en el dominio, pero **el endpoint de ventanas no lo usa**: se pueden pedir fragmentos en cualquier orden y reconstruir el PDF | Media (requisito del producto, no de seguridad) |
| **Sin MFA de administración** | Un admin comprometido puede publicar contenido y archivar documentos | Media |
| **Sin límite en `/api/activate`** | Fuerza bruta de tokens (32 bytes aleatorios: inviable, pero el riesgo sigue declarado) | Baja |

### 6.2 Aislamiento entre usuarios (lo que sí está bien)

- El progreso se lee por regla: `resource.data.uid == request.auth.uid` o admin.
  **El cliente no puede escribir** progreso, intentos ni cuentas.
- Los intentos solo los ve un administrador.
- `pdfChunks` está cerrado a todo cliente, **incluido el administrador**.
- El contenido público de un curso no lleva rutas ni ubicaciones.
- La sesión es cookie httpOnly + `Secure` + `SameSite=Lax`, con `claimsVersion`
  para invalidar sesiones al cambiar rol o estado.

### 6.3 Riesgo estructural que conviene nombrar

La clave de servicio de Firebase es **la llave maestra** del proyecto y vive en
el entorno del servidor. Si el host se compromete, el atacante puede leer y
escribir todo saltándose las reglas. En un servidor propio esto es más
controlable que en un PaaS compartido; en cualquier caso: clave restringida por
IAM (`datastore.user` + `firebaseauth.admin`), rotación documentada y **nunca**
en el repositorio.

---

## 7. Pruebas: qué sigue bloqueado

**Las 36 pruebas de reglas están escritas y no se ha ejecutado ninguna.** El
emulador es una aplicación Java y este entorno no tiene JVM; se cerraron cuatro
vías de instalación en la fase 2 y el intento posterior tampoco ha cambiado nada.

Qué queda sin comprobar **por ese bloqueo**:

| Comprobación | Qué podría fallar sin avisar |
| --- | --- |
| Sintaxis de `firestore.rules` (incluida la regla nueva de `pdfChunks`) | Un error de sintaxis se descubre **al desplegar**, no antes |
| Que `pdfChunks` esté realmente cerrado a clientes | Una fuga del binario completo |
| Que `documents` solo deje leer metadatos a cuentas activas | Metadatos visibles a cuentas deshabilitadas |
| Que `progress`/`progressHistory` aíslen por `uid` | Un alumno viendo el progreso de otro |
| Que las cuentas deshabilitadas pierdan acceso con token válido | Acceso tras despido |
| Que el comodín final deniegue rutas nuevas | Una colección futura abierta por olvido |

Y por **falta de proyecto/emulador** (no solo de Java):

| Comprobación | Estado |
| --- | --- |
| Transacción de escritura de fragmentos y contador de cuota | **No ejecutada** — y es donde vive el defecto del límite de 10 MiB (§4.2) |
| Que Firestore acepte 768 KiB de `Bytes` por documento | **Deducido de la documentación, no medido** |
| Suficiencia de los índices compuestos | **No comprobada** (`db:check` los ejecuta, pero necesita proyecto) |
| Límite de 6 índices: consultas reales del panel | **No comprobado** |
| 403 de un alumno autenticado en endpoints de admin | **No comprobado por HTTP** (requiere cookie de sesión real) |
| Restauración de una copia | **Ni existe el script ni el ensayo** |

Esto no es un trámite: **el único defecto nuevo de esta fase apareció al revisar
límites documentados**, no al ejecutar pruebas. Con emulador se habría visto en
la primera subida de un PDF grande.

---

## 8. Arquitectura recomendada

```
                    ┌──────────────────────────────────────────────┐
   Navegador  ────▶ │ Servidor Next.js (Node 22) en máquina propia │
   (HTTPS,          │ · sesión httpOnly (cookie del servidor)      │
    red interna     │ · endpoints /api/* (permisos por rol)        │
    o VPN)          │ · sirve ventanas de PDF de 768 KiB           │
                    │ · exportación de datos a disco               │
                    └───────────────┬──────────────────────────────┘
                                    │ Admin SDK (HTTPS)
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ Firebase Spark (sin facturación)             │
                    │ · Auth: correo/contraseña + claims           │
                    │ · Firestore: cuentas, cursos, progreso,      │
                    │   intentos, pdfChunks (Bytes), meta/storage  │
                    │ · Reglas cerradas; escrituras solo servidor  │
                    └──────────────────────────────────────────────┘
                                    │
                                    ▼
                    Copia manual cifrada fuera de la máquina
```

Decisiones que acompañan al esquema:

1. **Sin Storage, sin Functions, sin Hosting de Firebase, sin Blaze.**
2. **PDF ≤ 8 MiB** y comprimidos; fragmentos de 768 KiB; presupuesto 512 MiB.
3. **Filtro de matriculación** en `documents` y en la ventana de PDF.
4. **Límite por usuario** en el endpoint de ventanas (p. ej. 300 ventanas/hora),
   más caché en memoria de los fragmentos más pedidos (reduce lecturas y salida).
5. **Exportación diaria de lo pequeño** (cuentas, tokens, cursos, claves) y
   semanal de los binarios, con **ensayo de restauración** documentado.

---

## 9. Pasos siguientes, en orden

| # | Paso | Por qué ahora | Criterio de aceptación |
| --- | --- | --- | --- |
| 1 | **Corregir el tope de PDF a 8 MiB** (o diseñar la subida en dos fases) | Es un fallo que rompe la subida de PDF grandes | El tamaño máximo de una transacción queda por debajo de 10 MiB **y hay una prueba que lo comprueba** |
| 2 | **Añadir límite de peticiones y presupuesto por usuario** al endpoint de ventanas | Sin esto, un usuario puede tumbar la aplicación | Un bucle de 1 000 peticiones recibe 429 tras el umbral |
| 3 | **Implementar matriculación por curso** y aplicarla a `documents` y a las ventanas | Cierra el acceso cruzado entre cursos | Un alumno no matriculado recibe 403; las reglas lo reflejan |
| 4 | **Endpoint de páginas + `recordPageViewed`** | Hoy la lectura secuencial no se aplica al PDF | El servidor rechaza pedir la página 5 antes de la 4 |
| 5 | **Ejecutar las 36 pruebas de reglas** en una máquina con JDK | Es la única forma de saber si las reglas hacen lo que decimos | 36/36 en verde antes de cualquier despliegue |
| 6 | **Decidir alojamiento** y documentar el término aplicable | Condiciona todo lo demás | Servidor propio, o Netlify Free con medición de créditos |
| 7 | **Script de exportación + ensayo de restauración** | Sin ensayo no hay copia | Restauración cronometrada en un proyecto desechable |
| 8 | **Medir el corpus real** (nº de cursos, páginas y MiB tras comprimir) | Decide si 512 MiB bastan | Cifra documentada; si no cabe, plan B de §4.4 |
| 9 | Subir contenido real, importar personas y arrancar | Solo con 1–8 cerrados | `db:check` en 0 y reglas en verde |

---

## 10. Lo que no he podido verificar

- **Nada ejecutado contra Firestore, Auth ni Storage**: no hay proyecto y el
  emulador no arranca.
- **Ningún despliegue**: no se ha probado la aplicación en ninguno de los hosts
  comparados. Los límites son los publicados, no medidos con esta app.
- **Tamaño real del corpus** y del PDF medio.
- **Comportamiento de `firebase-admin` en cada PaaS** (memoria, cold start,
  tiempo de arranque del SDK): no medido.
- **Que el plan gratuito de Netlify baste**: depende del número de deploys y del
  tráfico real, que hoy no se conocen.
- Las cuotas de Google y de los hosts **pueden cambiar**; la fecha de consulta es
  el 21/10/2026.

---

## 11. Fuentes consultadas (21/10/2026)

- Firestore, cuotas y límites (1 MiB por documento, 10 MiB por petición, 270 s,
  50 000/20 000/20 000 diarios, 1 GiB, 10 GiB/mes; operaciones sin cuota
  gratuita): <https://firebase.google.com/docs/firestore/quotas>
- Planes de precios de Firebase (qué ocurre al agotar cuota en Spark):
  <https://firebase.google.com/docs/projects/billing/firebase-pricing-plans>
- Página de precios de Firebase: <https://firebase.google.com/pricing>
- Transacciones y escrituras por lotes (tamaño máximo de la petición):
  <https://firebase.google.com/docs/firestore/manage-data/transactions>
- Exportación/importación gestionada (requiere Blaze):
  <https://firebase.google.com/docs/firestore/manage-data/export-import>
- Copias de seguridad gestionadas (requieren Blaze):
  <https://firebase.google.com/docs/firestore/backups>
- PITR (requiere facturación): <https://firebase.google.com/docs/firestore/pitr>
- Vercel, guía de uso razonable (Hobby solo uso personal no comercial):
  <https://vercel.com/docs/limits/fair-use-guidelines>
- Vercel, plan Hobby y precios: <https://vercel.com/docs/plans/hobby> ·
  <https://vercel.com/pricing>
- Netlify, planes y créditos del plan Free: <https://www.netlify.com/pricing/>
- Render, instancias gratuitas (suspensión por inactividad, sin soporte de
  producción): <https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026>
- Cloudflare Workers, límites del plan gratuito (100 k peticiones/día, 10 ms de
  CPU, 128 MB): <https://developers.cloudflare.com/workers/platform/limits/>
