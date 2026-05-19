require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { db, admin } = require('./firebase-admin');
const app = express();
const BRANCH_ID = 'wa9igpvRpHkYpT7RPqgu';
const PAGE_SIZE = 8; // Máximo de ingredientes por listado en WhatsApp (reservando para botones Paginación/Terminar)

app.use(express.json());
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. VERIFICACIÓN DEL WEBHOOK DE META (GET)
// ==========================================
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ==========================================
// 2. RECEPCIÓN DE MENSAJES (POST)
// ==========================================
app.post('/webhook', async (req, res) => {
    const body = req.body;
    res.status(200).send('EVENT_RECEIVED'); // Responder rápido a Meta

    try {
        const val = body.entry?.[0]?.changes?.[0]?.value;
        const message = val?.messages?.[0];

        if (message) {
            const from = message.from;
            const sessionRef = db.collection('bot_sessions').doc(from);
            const sessionDoc = await sessionRef.get();
        
            // SESIÓN NUEVA
            if (!sessionDoc.exists) {
                await sessionRef.set({ status: 'START', createdAt: new Date() });
                await enviarMenuPrincipal(from);
            } 
            // SESIÓN EXISTENTE
            else {
                const sessionData = sessionDoc.data();
        
                // Si el usuario toca un botón o elemento de lista interactiva
                if (message.type === 'interactive') {
                    const selectionId = message.interactive.list_reply?.id;
                    await manejarSeleccionMenu(from, selectionId, sessionRef, sessionData);
                } 
                // Enrutamiento de textos libres (completar un producto tradicional)
                else if (message.type === 'text' && sessionData.status === 'CHOOSING_INGREDIENTS') {
                    const notasLibres = message.text.body;
                    await finalizarPedidoTradicional(from, sessionData.productId, notasLibres, sessionRef);
                }
            }
        }
    } catch (error) {
        console.error("Error:", error.response?.data || error.message);
    }
});

// ==========================================
// 3. ENRUTADOR PRINCIPAL DE COMPORTAMIENTOS
// ==========================================
async function manejarSeleccionMenu(numero, selectionId, sessionRef, sessionData) {
    console.log("Selección de usuario:", selectionId);

    // -------------------------------------------------------------
    // A. SELECCIONÓ UNA CATEGORÍA (ej: Frappes o Armar Crepa)
    // -------------------------------------------------------------
    if (selectionId.startsWith('cat_')) {
        const categoryId = selectionId.replace('cat_', '');
        const groupDoc = await db.collection('menu_groups').doc(categoryId).get();
        
        if (!groupDoc.exists) {
            return enviarMensajeTexto(numero, "Categoría no encontrada.");
        }
        const groupData = groupDoc.data();

        // Si la categoría tiene reglas_ref (EJ. ARMAR CREPA DULCE)
        if (groupData.rules_ref) {
            await sessionRef.update({ 
                status: 'BUILDING_CUSTOM', 
                categoryId: categoryId,
                selectedModifiers: [], 
                page: 0 
            });
            await enviarOpcionesIngredientes(numero, categoryId, 0, []);
        } 
        // Si es una categoría normal (EJ. BEBIDAS FRIAS)
        else {
            await sessionRef.update({ status: 'SELECTING_PRODUCT', lastCategory: categoryId });
            await enviarMenuProductos(numero, categoryId, "Menú de Productos");
        }
    } 
    
    // -------------------------------------------------------------
    // B. SELECCIONÓ UN INGREDIENTE PARA SU CREPA
    // -------------------------------------------------------------
    else if (selectionId.startsWith('ing_')) {
        const ingId = selectionId.replace('ing_', '');
        const currentSelected = sessionData.selectedModifiers || [];
        
        const modDoc = await db.collection('modifiers').doc(ingId).get();
        if (modDoc.exists) {
           const modData = modDoc.data();
           currentSelected.push({ id: ingId, name: modData.name, price: modData.price, group: modData.group });
           
           await sessionRef.update({ 
               selectedModifiers: currentSelected, 
               page: 0 // Resetear la página al añadir uno nuevo
           }); 
        }
        await enviarOpcionesIngredientes(numero, sessionData.categoryId, 0, currentSelected);
    }
    
    // -------------------------------------------------------------
    // C. PIDIÓ VER MÁS INGREDIENTES (Paginación)
    // -------------------------------------------------------------
    else if (selectionId.startsWith('page_')) {
        const nextPage = parseInt(selectionId.replace('page_', ''), 10);
        await sessionRef.update({ page: nextPage });
        await enviarOpcionesIngredientes(numero, sessionData.categoryId, nextPage, sessionData.selectedModifiers || []);
    }
    
    // -------------------------------------------------------------
    // D. TERMINAR DE ARMAR SU CREPA MULTI-INGREDIENTE
    // -------------------------------------------------------------
    else if (selectionId === 'finish_custom') {
        await finalizarCustomPedido(numero, sessionRef, sessionData);
    }

    // -------------------------------------------------------------
    // E. SELECCIONÓ UN PRODUCTO TRADICIONAL DIRECTO FIJO
    // -------------------------------------------------------------
    else if (selectionId.startsWith('prod_')) {
        const productId = selectionId.replace('prod_', '');
        await sessionRef.update({ 
            status: 'CHOOSING_INGREDIENTS', 
            productId: productId 
        });
        await enviarMensajeTexto(numero, "¿Qué ingredientes o notas adicionales prefieres? (Escribe tu respuesta)");
    }
}

// ==========================================
// 4. LÓGICA DE MENÚS "ARMABLES" (CREPAS)
// ==========================================
async function enviarOpcionesIngredientes(numero, categoryId, page, selectedModifiers) {
    const groupDoc = await db.collection('menu_groups').doc(categoryId).get();
    const groupData = groupDoc.data();

    // Reunir bases, extras y toppings de esa categoría armable
    const groupsToFetch = [];
    if (groupData.base_group) groupsToFetch.push(groupData.base_group);
    if (groupData.extra_groups) groupsToFetch.push(...groupData.extra_groups);
    if (groupData.topping_groups) groupsToFetch.push(...groupData.topping_groups);

    if (groupsToFetch.length === 0) {
        return enviarMensajeTexto(numero, "Esta categoría no tiene ingredientes configurados.");
    }

    // Extraer modifiers
    const modsSnap = await db.collection('modifiers').where('group', 'in', groupsToFetch).get();
    const todosIngredientes = [];
    modsSnap.forEach(doc => {
        todosIngredientes.push({ id: doc.id, ...doc.data() });
    });

    // Paginación de arrays
    const totalPages = Math.ceil(todosIngredientes.length / PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const ingredientesPagina = todosIngredientes.slice(start, end);
    
    const rows = [];

    // Botón especial para TERMINAR (Aparece una vez que escogen 1 o más ingredientes)
    if (selectedModifiers.length > 0) {
        rows.push({
            id: 'finish_custom',
            title: '✅ ¡LISTO! TERMINAR',
            description: `Llevas ${selectedModifiers.length} ingrediente(s)`
        });
    }

    // Llenar ingredientes de este trozo
    ingredientesPagina.forEach(ing => {
        rows.push({
            id: `ing_${ing.id}`,
            title: ing.name.substring(0, 24),
            description: `+$${ing.price}`
        });
    });

    // Botón especial para SIGUIENTES INGREDIENTES
    if (page < totalPages - 1) {
        rows.push({
            id: `page_${page + 1}`,
            title: '👉 VER MÁS OPCIONES',
            description: 'Avanzar a más ingredientes'
        });
    }

    // Mensaje Interactivo Personalizado
    let cuerpoMensaje = "Elige tus ingredientes uno por uno:";
    if (selectedModifiers.length > 0) {
        const resumen = selectedModifiers.map(m => m.name).join(", ");
        cuerpoMensaje = `Tu pedido lleva:\n👉 ${resumen}\n\nAgrega más, o presiona "¡LISTO! TERMINAR".`;
    }

    // Evitamos enviar títulos que pasen los límites de WhatsApp (20 caracteres para Body no, pero Title sí es estricto)
    await enviarListaWhatsApp(
        numero,
        groupData.name.substring(0, 24), 
        cuerpoMensaje,
        "Ingredientes",
        rows
    );
}

// ==========================================
// 5. CERRAR ORDEN: PRODUCTO "ARMABLE" (Híbrido)
// ==========================================
async function finalizarCustomPedido(numero, sessionRef, sessionData) {
    try {
        const groupDoc = await db.collection('menu_groups').doc(sessionData.categoryId).get();
        const groupData = groupDoc.data();

        // 1. Traer la regla contable exacta del Firebase
        const ruleDoc = await db.collection('price_rules').doc(groupData.rules_ref).get();
        const rule = ruleDoc.data();
        
        const count = sessionData.selectedModifiers.length;
        let precioFinal = 0;

        // 2. Lógica Híbrida Inteligente (Idéntica al código POS que hicimos)
        const sortedRules = [...(rule.basePrices || [])].sort((a, b) => b.count - a.count);
        const maxRule = sortedRules[0];

        if (maxRule && count > maxRule.count) {
            // Ejemplo: rebasan los 3 escalones. Cobra el 3ro + el incremento extra
            const extraCount = count - maxRule.count;
            const incremento = rule.incrementPerIngredient || 10;
            precioFinal = maxRule.price + (extraCount * incremento);
        } else if (maxRule) {
            // Cae exactito en uno de los escalones
            const matched = sortedRules.find(r => count >= r.count);
            precioFinal = matched ? matched.price : 0;
        }

        // 3. Empaquetar Pedido Inyectable KDS
        const nuevoPedidoKDS = {
            orderNumber: `WA-${Math.floor(Math.random() * 900) + 100}`,
            customerName: `WhatsApp: ${numero.slice(-4)}`,
            status: 'PAID',
            kitchenStatus: 'pending', 
            orderMode: 'WhatsApp',
            branchId: BRANCH_ID,
            createdAt: admin.firestore.Timestamp.now(),
            total: precioFinal,
            items: [{
                ticketItemId: Date.now().toString(),
                baseName: groupData.name,
                price: precioFinal,
                type: 'CUSTOM', // Importantísimo para el POS 
                quantity: 1,
                details: {
                    basePriceRule: groupData.rules_ref,
                    selectedModifiers: sessionData.selectedModifiers
                }
            }]
        };

        // 4. Enviar a Cocina (y a historial de orders)
        await db.collection('orders').add(nuevoPedidoKDS);
        await enviarMensajeTexto(numero, `👨‍🍳 ¡Excelente! Tu combinación se mandó a cocina.\n\nTotal a Pagar: *$${precioFinal}*\n\n¡Gracias por tu preferencia!`);
        await sessionRef.delete(); // Limpiar Chat

    } catch (error) {
        console.error("Error al finalizar crepa:", error);
        await enviarMensajeTexto(numero, "Hubo un error al procesar tu crepa.");
    }
}

// ==========================================
// 6. CERRAR ORDEN: PRODUCTO NORMAL FIJO
// ==========================================
async function finalizarPedidoTradicional(numero, productId, notasLibres, sessionRef) {
    try {
        const productDoc = await db.collection('menu_items').doc(productId).get();
        if (!productDoc.exists) {
            return enviarMensajeTexto(numero, "Lo sentimos, hubo un error con el producto.");
        }

        const productData = productDoc.data();
        const precioFinal = productData.branchPrices?.[BRANCH_ID] || productData.price || 0;

        const nuevoPedidoKDS = {
            orderNumber: `WA-${Math.floor(Math.random() * 900) + 100}`,
            customerName: `WhatsApp: ${numero.slice(-4)}`,
            status: 'PAID',
            kitchenStatus: 'pending', 
            orderMode: 'WhatsApp',
            branchId: BRANCH_ID,
            createdAt: admin.firestore.Timestamp.now(),
            total: precioFinal,
            items: [{
                ticketItemId: Date.now().toString(),
                baseName: productData.name,
                price: precioFinal,
                type: 'FIXED', 
                quantity: 1,
                details: {
                    variantName: "Normal",
                    selectedModifiers: [{ 
                        name: notasLibres, 
                        price: 0, 
                        group: "Notas" 
                    }]
                }
            }]
        };

        await db.collection('orders').add(nuevoPedidoKDS);
        await enviarMensajeTexto(numero, `¡Excelente! Tu ${productData.name} está en preparación.\n\nEl total es de *$${precioFinal}*.\n\n¡Gracias!`);
        await sessionRef.delete();

    } catch (error) {
        console.error("Error crítico al enviar al KDS tradicional:", error);
        await enviarMensajeTexto(numero, "Tuve un problema al enviar tu orden a la cocina. Inténtalo más tarde.");
    }
}

// ==========================================
// 7. FUNCIONES DE API DE WHATSAPP (UTILITIES)
// ==========================================
async function enviarMenuPrincipal(numero) {
    try {
        const rootDoc = await db.collection('menu_groups').doc('root').get();
        if (!rootDoc.exists) return enviarMensajeTexto(numero, "Menú no disponible al momento.");

        const categoriesIds = rootDoc.data().children || [];
        const categoriesSnap = await db.collection('menu_groups').where(admin.firestore.FieldPath.documentId(), 'in', categoriesIds).get();

        const rows = [];
        categoriesSnap.forEach(doc => {
            const data = doc.data();
            rows.push({
                id: `cat_${doc.id}`,
                title: data.name.substring(0, 24)
            });
        });

        // Solo top 10 Categorias por limite de WA
        await enviarListaWhatsApp(numero, "¡Hola! Bienvenido a Dulce Crepa", "Para iniciar tu orden, dime:", "Empezar", rows.slice(0, 10));

    } catch (error) {
        console.error("Error en menú principal:", error);
    }
}

async function enviarMenuProductos(numero, categoryId, categoryName) {
    try {
        const groupDoc = await db.collection('menu_groups').doc(categoryId).get();
        if (!groupDoc.exists) return enviarMensajeTexto(numero, "Categoría no encontrada.");

        const itemsIds = groupDoc.data().items_ref || [];
        if (itemsIds.length === 0) return enviarMensajeTexto(numero, "Próximamente tendremos opciones disponibles aquí.");

        const itemsSnap = await db.collection('menu_items').where(admin.firestore.FieldPath.documentId(), 'in', itemsIds).get();

        const allRows = [];
        itemsSnap.forEach(doc => {
            const data = doc.data();
            const precioMostrado = data.branchPrices?.[BRANCH_ID] || data.price || 0;
            
            allRows.push({
                id: `prod_${doc.id}`,
                title: data.name.substring(0, 24),
                description: `Precio: $${precioMostrado}` 
            });
        });

        await enviarListaWhatsApp(
            numero, 
            categoryName.substring(0, 24), 
            "Selecciona tu opción favorita:", 
            "Menú", 
            allRows.slice(0, 10)
        );

    } catch (error) {
        console.error("Error al cargar menú:", error);
    }
}

async function enviarListaWhatsApp(numero, titulo, cuerpo, nombreBoton, filas) {
    await axios({
        method: "POST",
        url: `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`,
        data: {
            messaging_product: "whatsapp",
            to: numero,
            type: "interactive",
            interactive: {
                type: "list",
                header: { type: "text", text: titulo },
                body: { text: cuerpo },
                action: {
                    button: nombreBoton,
                    sections: [{ title: "Toca una opción", rows: filas }]
                }
            }
        },
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.WA_TOKEN}`,
        },
    });
}

async function enviarMensajeTexto(numero, texto) {
    await axios({
        method: "POST",
        url: `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`,
        data: {
            messaging_product: "whatsapp",
            to: numero,
            type: "text", 
            text: { body: texto },
        },
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.WA_TOKEN}`,
        },
    });
}

// INICIAR EL SERVIDOR
app.listen(PORT, () => console.log(`[WA-BOT] Servidor activo escuchando en puerto ${PORT}`));
