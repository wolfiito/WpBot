require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { db, admin } = require('./firebase-admin');
const app = express();
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

            if (!sessionDoc.exists || message.text?.body?.toLowerCase() === 'hola') {
                const branchesSnap = await db.collection('branches').where('isActive', '==', true).get();

                const rows = [];
                branchesSnap.forEach(doc => {
                    const data = doc.data();
                    rows.push({
                        id: `branch_${doc.id}`,
                        title: data.name ? data.name.substring(0, 24) : 'Sucursal',
                        description: "Elegir sucursal"
                    });
                });

                if (rows.length === 0) {
                    // Fallback in case no branches exist
                    await sessionRef.set({
                        status: 'START',
                        cart: [],
                        branchId: 'wa9igpvRpHkYpT7RPqgu',
                        createdAt: admin.firestore.Timestamp.now()
                    });
                    await enviarMenuPrincipal(from, [], 'wa9igpvRpHkYpT7RPqgu');
                } else if (rows.length === 1) {
                    const singleBranchId = rows[0].id.replace('branch_', '');
                    await sessionRef.set({
                        status: 'START',
                        cart: [],
                        branchId: singleBranchId,
                        createdAt: admin.firestore.Timestamp.now()
                    });
                    await enviarMenuPrincipal(from, [], singleBranchId);
                } else {
                    await sessionRef.set({
                        status: 'SELECTING_BRANCH',
                        cart: [],
                        createdAt: admin.firestore.Timestamp.now()
                    });
                    await enviarListaWhatsApp(from, "Bienvenido a Món", "Por favor, elige la sucursal de tu pedido:", "Sucursales", rows.slice(0, 10));
                }
            } else {
                const sessionData = sessionDoc.data();

                if (message.type === 'interactive') {
                    const selectionId = message.interactive.list_reply?.id || message.interactive.button_reply?.id;
                    // IMPORTANTE: Pasamos sessionData aquí para que el cerebro tenga el contexto de carritos
                    await manejarSeleccionMenu(from, selectionId, sessionRef, sessionData);
                } else if (message.type === 'text') {
                    await manejarTexto(from, message.text.body, sessionRef, sessionData);
                }
            }
        }
    } catch (error) {
        console.error("Error en Webhook POST:", error.response?.data || error.message);
    }
});


async function startConfiguringInstance(numero, index, totalQty, productData, sessionRef) {
    const isMulti = totalQty > 1;
    const itemTitle = productData.name + (isMulti ? ` (Unidad #${index})` : "");
    const sessionSnap = await sessionRef.get();
    const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';

    let basePrice = 0;
    if (!productData.variants || productData.variants.length === 0) {
        basePrice = productData.branchPrices?.[branchId] || productData.price || 0;
    }

    const pendingItem = {
        id: `linea-${Date.now()}`,
        productId: productData.id,
        baseName: itemTitle,
        finalPrice: basePrice,
        type: (productData.variants && productData.variants.length > 0) ? 'VARIANT' : 'FIXED',
        quantity: 1,
        details: { selectedModifiers: [] }
    };

    if (productData.variants && productData.variants.length > 0) {
        await sessionRef.update({
            status: 'SELECTING_VARIANT',
            pendingItem: pendingItem,
            variants: productData.variants,
            pendingModifiers: productData.modifierGroups || []
        });
        return await enviarOpcionesVariantes(numero, itemTitle, productData.variants);
    } else {
        await sessionRef.update({
            pendingItem: pendingItem
        });
        return await procesarSiguienteModificador(numero, pendingItem, productData.modifierGroups || [], sessionRef);
    }
}

async function manejarTexto(numero, textoLimpio, sessionRef, sessionData) {
    const texto = textoLimpio.trim().toLowerCase();

    if (sessionData.status === 'ASK_QTY_PROD' || sessionData.status === 'ASK_QTY_CUSTOM') {
        const qty = parseInt(texto, 10);
        if (isNaN(qty) || qty <= 0 || qty > 100) return enviarMensajeTexto(numero, "Por favor, escribe un número válido para la cantidad (ejemplo: 2).");

        if (sessionData.status === 'ASK_QTY_CUSTOM') {
            await sessionRef.update({
                status: 'CHOOSING_MULTIPLE_EXTRAS',
                totalQty: qty,
                currentQtyIndex: 1,
                configuredItems: []
            });
            return await enviarOpcionesIngredientes(numero, sessionData.categoryId, 1, qty);
        } else {
            // Producto Normal Fijo o con Modificadores
            const productDoc = await db.collection('menu_items').doc(sessionData.productId).get();
            const productData = productDoc.data();

            if (!sessionData.hasConfig) {
                // Producto simple directo
                const currentCart = sessionData.cart || [];
                currentCart.push({
                    id: `linea-${Date.now()}`,
                    baseName: sessionData.productName,
                    productId: sessionData.productId,
                    finalPrice: sessionData.productPrice * qty,
                    type: 'FIXED',
                    quantity: qty,
                    details: { selectedModifiers: [] }
                });
                await sessionRef.update({
                    status: 'START', cart: currentCart,
                    productId: admin.firestore.FieldValue.delete(),
                    productName: admin.firestore.FieldValue.delete(),
                    productPrice: admin.firestore.FieldValue.delete(),
                    hasConfig: admin.firestore.FieldValue.delete()
                });
                await enviarMensajeTexto(numero, `🛒 Se agregaron *${qty}x ${sessionData.productName}* al carrito.`);
                return await enviarMenuPrincipal(numero, currentCart);
            } else {
                // Producto con variantes o modificadores
                await sessionRef.update({
                    status: 'CONFIGURING_PROD',
                    totalQty: qty,
                    currentQtyIndex: 1,
                    configuredItems: [],
                    productId: sessionData.productId
                });
                return await startConfiguringInstance(numero, 1, qty, productData, sessionRef);
            }
        }
    }

    if (sessionData.status === 'CHOOSING_MULTIPLE_EXTRAS') {
        const opciones = textoLimpio.split(',').map(s => s.trim());
        const selectedModifiers = [];
        const { availableIngredients } = sessionData;

        let error = false;
        opciones.forEach(num => {
            if (availableIngredients && availableIngredients[num]) {
                selectedModifiers.push(availableIngredients[num]);
            } else {
                error = true;
            }
        });

        if (selectedModifiers.length === 0) {
            return await enviarMensajeTexto(numero, "❌ Por favor escribe al menos un número válido de la lista de ingredientes (Ej: 1, 2, 4)");
        }

        if (error) {
            await enviarMensajeTexto(numero, "⚠️ Algunos números no se encontraron y fueron omitidos.");
        }

        const modRef = db.collection('bot_sessions').doc(numero);
        await modRef.update({
            selectedModifiers: selectedModifiers,
            availableIngredients: admin.firestore.FieldValue.delete()
        });

        const updatedSession = Object.assign({}, sessionData, { selectedModifiers });
        return await finalizarCustomPedido(numero, modRef, updatedSession);
    }

    // Respuesta por defecto si mandan texto libre fuera de contexto
    await enviarMensajeTexto(numero, "Por favor, utiliza los botones y listas del menú para interactuar.");
}

// ==========================================
// 3. ENRUTADOR PRINCIPAL DE COMPORTAMIENTOS
// ==========================================
async function manejarSeleccionMenu(numero, selectionId, sessionRef, sessionData) {
    console.log("[WA-BOT] Procesando ID interactivo:", selectionId);
    let currentCart = sessionData.cart || [];
    const branchId = sessionData.branchId;

    if (selectionId.startsWith('branch_')) {
        const pickedBranchId = selectionId.replace('branch_', '');
        await sessionRef.update({ status: 'START', branchId: pickedBranchId });
        await enviarMensajeTexto(numero, "✅ Sucursal seleccionada correctamente.");
        return await enviarMenuPrincipal(numero, currentCart, pickedBranchId);
    }

    if (selectionId.startsWith('next_')) {
        const partes = selectionId.replace('next_', '').split('_');
        const offset = parseInt(partes.pop(), 10);
        const categoryId = partes.join('_'); // Reconstruye por si el ID tiene guiones bajos

        const groupDoc = await db.collection('menu_groups').doc(categoryId).get();
        if (!groupDoc.exists) return await enviarMensajeTexto(numero, "Categoría no encontrada.");
        const groupData = groupDoc.data();

        return await enviarCategoriaMixta(numero, groupData.children || [], groupData.items_ref || [], groupData.name, offset, currentCart, categoryId);
    }
    // ==========================================
    // 🛒 GESTIÓN DE CARRITO Y CHECKOUT
    // ==========================================
    if (selectionId === 'btn_ver_carrito') {
        if (currentCart.length === 0) {
            return await enviarMensajeTexto(numero, "Tu carrito está vacío.");
        }
        return await enviarResumenCarrito(numero, currentCart);
    }

    if (selectionId === 'btn_enviar_cocina') {
        return await procesarEnvioKds(numero, currentCart, sessionRef);
    }

    // ==========================================
    // 📂 CASO 1: SELECCIÓN DE CATEGORÍA (cat_)
    // ==========================================
    if (selectionId.startsWith('cat_')) {
        const categoryId = selectionId.replace('cat_', '');
        const groupDoc = await db.collection('menu_groups').doc(categoryId).get();

        if (!groupDoc.exists) return;
        const groupData = groupDoc.data();

        // B. Categorías Armables (Crepas / Hotcakes con rules_ref)
        if (groupData.rules_ref) {
            await sessionRef.update({
                status: 'ASK_QTY_CUSTOM',
                categoryId: categoryId,
                currentBuildingName: groupData.name
            });
            return await enviarMensajeTexto(numero, `¿Cuántas unidades de ${groupData.name} vas a armar? Escribe el número:`);
        }

        // A. Categoria Mixta (Sub-carpetas y/o productos fijos en el mismo folder)
        await sessionRef.update({ status: 'NAVIGATING', lastCategory: categoryId });
        return await enviarCategoriaMixta(numero, groupData.children || [], groupData.items_ref || [], groupData.name, 0, currentCart, categoryId);
    }

    // ==========================================
    // 🍕 CASO 2: SELECCIÓN DE PRODUCTO (prod_)
    // ==========================================
    if (selectionId.startsWith('prod_')) {
        const productId = selectionId.replace('prod_', '');
        const productDoc = await db.collection('menu_items').doc(productId).get();
        if (!productDoc.exists) return;

        const productData = productDoc.data();
        let precioBase = 0;
        let esVariante = false;

        if (productData.variants && productData.variants.length > 0) {
            esVariante = true;
        } else {
            precioBase = productData.branchPrices?.[branchId] || productData.price || 0;
        }

        const hasConfig = esVariante || (productData.modifierGroups && productData.modifierGroups.length > 0);

        await sessionRef.update({
            status: 'ASK_QTY_PROD',
            productId: productId,
            productName: productData.name,
            productPrice: precioBase,
            hasConfig: hasConfig
        });

        return await enviarMensajeTexto(numero, `¿Cuántas unidades de ${productData.name} deseas? Escribe el número (ejemplo: 2):`);
    }

    // ==========================================
    // 🥬 CASO: SELECCIÓN DE INGREDIENTES ARMABLES (ing_)
    // ==========================================
    if (selectionId.startsWith('ing_')) {
        const modId = selectionId.replace('ing_', '');
        const modDoc = await db.collection('modifiers').doc(modId).get();
        if (!modDoc.exists) return;
        const modData = modDoc.data();

        const sessionSnap = await sessionRef.get();
        const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';

        const modPrecio = modData.branchPrices?.[branchId] || modData.price || 0;
        const modificadorSeleccionado = {
            id: modId,
            name: modData.name,
            price: modPrecio,
            group: modData.group
        };

        const currentModifiers = sessionData.selectedModifiers || [];
        currentModifiers.push(modificadorSeleccionado);

        await sessionRef.update({ selectedModifiers: currentModifiers });
        return await enviarOpcionesIngredientes(numero, sessionData.categoryId, 0, currentModifiers);
    }

    if (selectionId.startsWith('page_')) {
        const page = parseInt(selectionId.replace('page_', ''), 10);
        return await enviarOpcionesIngredientes(numero, sessionData.categoryId, page, sessionData.selectedModifiers || []);
    }

    if (selectionId === 'finish_custom') {
        return await finalizarCustomPedido(numero, sessionRef, sessionData);
    }

    // ==========================================
    // 🚫 CASO: SALTAR MODIFICADOR (skip_mod)
    // ==========================================
    if (selectionId === 'skip_mod') {
        if (sessionData.status === 'SELECTING_MODIFIER') {
            const pendingItem = sessionData.pendingItem;
            const nuevosPendientes = sessionData.pendingModifiers.slice(1);
            return await procesarSiguienteModificador(numero, pendingItem, nuevosPendientes, sessionRef);
        }
    }

    // ==========================================
    // 🥦 CASO 3: SELECCIÓN DE MODIFICADOR DIRECTO (mod_)
    // ==========================================
    if (selectionId.startsWith('mod_')) {
        const modId = selectionId.replace('mod_', '');
        const modDoc = await db.collection('modifiers').doc(modId).get();
        if (!modDoc.exists) return;
        const modData = modDoc.data();
        const modPrecio = modData.branchPrices?.[BRANCH_ID] || modData.price || 0;

        const modificadorSeleccionado = {
            id: modId,
            name: modData.name,
            price: modPrecio,
            group: modData.group
        };

        // Sub-caso C: Resolviendo modificadores secuenciales de producto


        // Sub-caso C: Resolviendo modificadores exclusivos de un producto (Secuenciales)
        if (sessionData.status === 'SELECTING_MODIFIER') {
            const pendingItem = sessionData.pendingItem;
            pendingItem.finalPrice += modPrecio;
            pendingItem.details.selectedModifiers.push(modificadorSeleccionado);

            const nuevosPendientes = sessionData.pendingModifiers.slice(1);
            return await procesarSiguienteModificador(numero, pendingItem, nuevosPendientes, sessionRef);
        }
    }

    // ==========================================
    // ☕ CASO 4: SELECCIÓN DE VARIANTE (var_)
    // ==========================================
    if (selectionId.startsWith('var_')) {
        const varIndex = parseInt(selectionId.replace('var_', ''), 10);
        const { pendingItem, variants, pendingModifiers } = sessionData;
        const varianteSeleccionada = variants[varIndex];

        const sessionSnap = await sessionRef.get();
        const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';

        const precioVar = varianteSeleccionada.branchPrices?.[branchId] || varianteSeleccionada.price || 0;

        pendingItem.finalPrice = precioVar;
        pendingItem.details.variantName = varianteSeleccionada.name;

        return await procesarSiguienteModificador(numero, pendingItem, pendingModifiers || [], sessionRef);
    }
}

async function procesarSiguienteModificador(numero, pendingItem, pendingModifiers, sessionRef) {
    let nextGroup;
    let remaining = [...pendingModifiers];
    let modsSnap;
    let foundModifiers = false;

    while (remaining.length > 0) {
        nextGroup = remaining[0];
        modsSnap = await db.collection('modifiers').where('group', '==', nextGroup).get();

        if (!modsSnap.empty) {
            foundModifiers = true;
            break;
        } else {
            // Este grupo de aditamentos estaba vacío, pasamos silenciosamente al siguiente
            remaining.shift();
        }
    }

    if (foundModifiers) {
        const rows = [
            { id: 'skip_mod', title: '🚫 Ninguno / Saltar', description: 'Omitir esta opción' }
        ];

        const sessionSnap = await sessionRef.get();
        const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';

        let addedCount = 1;
        modsSnap.forEach(doc => {
            if (addedCount >= 10) return; // WhatsApp Limita
            addedCount++;

            const data = doc.data();
            const precio = data.branchPrices?.[branchId] || data.price || 0;
            rows.push({
                id: `mod_${doc.id}`,
                title: data.name.substring(0, 24),
                description: precio > 0 ? `+$${precio}` : "Sin costo extra"
            });
        });

        await sessionRef.update({
            status: 'SELECTING_MODIFIER',
            pendingItem: pendingItem,
            pendingModifiers: remaining
        });

        await enviarListaWhatsApp(
            numero,
            pendingItem.baseName.substring(0, 24),
            "Selecciona una opción extra:",
            "Ver opciones",
            rows.slice(0, 10)
        );
    } else {
        // TERMINÓ DE CONFIGURAR LA INSTANCIA ACTUAL
        const sessionSnap = await sessionRef.get();
        const sessionInfo = sessionSnap.data();

        let configuredItems = sessionInfo.configuredItems || [];
        configuredItems.push(pendingItem);

        if (sessionInfo.currentQtyIndex < sessionInfo.totalQty) {
            const nextIndex = sessionInfo.currentQtyIndex + 1;
            await sessionRef.update({ currentQtyIndex: nextIndex, configuredItems: configuredItems });

            const productDoc = await db.collection('menu_items').doc(sessionInfo.productId).get();
            await enviarMensajeTexto(numero, `✅ Configurado ${pendingItem.baseName}. Pasemos a confirmar la unidad #${nextIndex}...`);
            return await startConfiguringInstance(numero, nextIndex, sessionInfo.totalQty, productDoc.data(), sessionRef);
        } else {
            // Terminado TODO!
            const currentCart = sessionInfo.cart || [];
            currentCart.push(...configuredItems);

            await sessionRef.update({
                status: 'START', cart: currentCart,
                configuredItems: admin.firestore.FieldValue.delete(),
                currentQtyIndex: admin.firestore.FieldValue.delete(),
                totalQty: admin.firestore.FieldValue.delete(),
                productId: admin.firestore.FieldValue.delete(),
                pendingItem: admin.firestore.FieldValue.delete(),
                pendingModifiers: admin.firestore.FieldValue.delete(),
                variants: admin.firestore.FieldValue.delete()
            });

            await enviarMensajeTexto(numero, `🛒 ¡Productos agregados al carrito con éxito!`);
            return await enviarMenuPrincipal(numero, currentCart);
        }
    }
}



async function enviarSubcategorias(numero, childrenIds, parentName) {
    try {
        const categoriesSnap = await db.collection('menu_groups')
            .where(admin.firestore.FieldPath.documentId(), 'in', childrenIds)
            .get();

        const rows = [];
        categoriesSnap.forEach(doc => {
            rows.push({
                id: `cat_${doc.id}`,
                title: doc.data().name.substring(0, 24)
            });
        });

        await enviarListaWhatsApp(
            numero,
            parentName.substring(0, 20),
            "Elige una subcategoría:",
            "Ver opciones",
            rows.slice(0, 10)
        );
    } catch (error) {
        console.error("Error al cargar subcategorías:", error);
    }
}

// ==========================================
// 4. LÓGICA TEXTUAL MULTI-INGREDIENTES Y CATEGORÍAS
// ==========================================
async function enviarOpcionesIngredientes(numero, categoryId, currentQtyIndex = 1, totalQty = 1) {
    const groupDoc = await db.collection('menu_groups').doc(categoryId).get();
    const groupData = groupDoc.data();

    const groupsToFetch = [];
    if (groupData.base_group) groupsToFetch.push(groupData.base_group);
    if (groupData.extra_groups) groupsToFetch.push(...groupData.extra_groups);
    if (groupData.topping_groups) groupsToFetch.push(...groupData.topping_groups);

    if (groupsToFetch.length === 0) {
        return enviarMensajeTexto(numero, "Esta categoría no tiene ingredientes configurados.");
    }

    const modsSnap = await db.collection('modifiers').where('group', 'in', groupsToFetch).get();

    const mapIngredientes = {};
    let headerArmando = `🎨 *Armando: ${groupData.name}`;
    if (totalQty > 1) headerArmando += ` (Unidad #${currentQtyIndex} de ${totalQty})`;
    headerArmando += "*";

    let mensajeOpciones = `${headerArmando}\nPor favor elige los números de los ingredientes que vas a querer y envíalos separados por comas. (Ejemplo: *1, 4, 12, 13*)\n\n*Catálogo de Opciones:*\n`;

    const sessionSnap = await db.collection('bot_sessions').doc(numero).get();
    const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';
    let counter = 1;
    modsSnap.forEach(doc => {
        const data = doc.data();
        const precio = data.branchPrices?.[branchId] || data.price || 0;

        mapIngredientes[counter.toString()] = {
            id: doc.id,
            name: data.name,
            price: precio,
            group: data.group
        };

        mensajeOpciones += `${counter}. ${data.name} ${precio > 0 ? `(+$${precio})` : ''}\n`;
        counter++;
    });

    await db.collection('bot_sessions').doc(numero).update({
        status: 'CHOOSING_MULTIPLE_EXTRAS',
        availableIngredients: mapIngredientes
    });

    await enviarMensajeTexto(numero, mensajeOpciones);
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

        const sessionSnap = await sessionRef.get();
        const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';

        const baseGroup = groupData.base_group;
        let count = 0;
        let extraPrice = 0;

        sessionData.selectedModifiers.forEach(mod => {
            if (mod.group === baseGroup) count++;
            if (mod.price > 0) extraPrice += mod.price;
        });

        let basePrice = 0;

        // 2. Lógica Híbrida Inteligente (Idéntica al código POS que hicimos)
        const sortedRules = [...(rule.basePrices || [])].sort((a, b) => b.count - a.count);
        const maxRule = sortedRules[0];

        if (maxRule && count > maxRule.count) {
            // Ejemplo: rebasan los 3 escalones. Cobra el 3ro + el incremento extra
            const extraCount = count - maxRule.count;
            const maxRulePrice = maxRule.branchPrices?.[branchId] ?? maxRule.price;
            const incremento = rule.incrementPerIngredient ?? 10;
            basePrice = maxRulePrice + (extraCount * incremento);
        } else if (maxRule) {
            // Cae exactito en uno de los escalones
            const matched = sortedRules.find(r => count >= r.count);
            basePrice = matched ? (matched.branchPrices?.[branchId] ?? matched.price) : 0;
        } else if (rule.initialPrice !== undefined && rule.incrementPerIngredient !== undefined) {
            // LINEAL PURO
            basePrice = rule.initialPrice + (Math.max(0, count - 1) * rule.incrementPerIngredient);
        }

        const precioFinal = basePrice + extraPrice;

        const baseItem = {
            id: `linea-${Date.now()}`,
            baseName: groupData.name + (sessionData.totalQty > 1 ? ` #${sessionData.currentQtyIndex}` : ""),
            finalPrice: precioFinal,
            type: 'CUSTOM',
            quantity: 1,
            productId: sessionData.categoryId,
            details: {
                basePriceRule: groupData.rules_ref,
                selectedModifiers: sessionData.selectedModifiers
            }
        };

        const configuredItems = sessionData.configuredItems || [];
        configuredItems.push(baseItem);

        if (sessionData.currentQtyIndex < sessionData.totalQty) {
            const nextIndex = sessionData.currentQtyIndex + 1;
            await sessionRef.update({ currentQtyIndex: nextIndex, configuredItems: configuredItems });
            await enviarMensajeTexto(numero, `✅ Tu ${groupData.name} #${sessionData.currentQtyIndex} está armada. Ahora configuremos la #${nextIndex}:`);
            return await enviarOpcionesIngredientes(numero, sessionData.categoryId, nextIndex, sessionData.totalQty);
        } else {
            const currentCart = sessionData.cart || [];
            currentCart.push(...configuredItems);

            await sessionRef.update({
                status: 'START',
                cart: currentCart,
                configuredItems: admin.firestore.FieldValue.delete(),
                currentQtyIndex: admin.firestore.FieldValue.delete(),
                totalQty: admin.firestore.FieldValue.delete(),
                categoryId: admin.firestore.FieldValue.delete(),
                availableIngredients: admin.firestore.FieldValue.delete(),
                selectedModifiers: admin.firestore.FieldValue.delete(),
                rulesRef: admin.firestore.FieldValue.delete(),
                currentBuildingName: admin.firestore.FieldValue.delete()
            });
            await enviarMensajeTexto(numero, `🛒 ¡Agregado al carrito con éxito!`);
            return await enviarMenuPrincipal(numero, currentCart);
        }

    } catch (error) {
        console.error("Error al procesar armado:", error);
        await enviarMensajeTexto(numero, "Hubo un error al armar tu producto.");
    }
}



// ==========================================
// 7. FUNCIONES DE API DE WHATSAPP (UTILITIES)
// ==========================================
async function enviarMenuPrincipal(numero, cart) {
    try {
        const rootDoc = await db.collection('menu_groups').doc('root').get();
        if (!rootDoc.exists) return;

        await enviarCategoriaMixta(numero, rootDoc.data().children || [], rootDoc.data().items_ref || [], "Menú de Món", 0, cart);
    } catch (error) {
        console.error("Error en menú principal:", error);
    }
}

async function enviarCategoriaMixta(numero, childrenIds, itemsIds, categoryName, offset = 0, cart = null, categoryId = 'root', branchId = 'wa9igpvRpHkYpT7RPqgu') {
    try {
        const allRows = [];

        // 1. Obtener y añadir los hijos (Sub-groups) buscando quien sea hijo del categoryId
        const categoriesSnap = await db.collection('menu_groups')
            .where('parent', '==', categoryId)
            .get();

        categoriesSnap.forEach(doc => {
            allRows.push({
                id: `cat_${doc.id}`,
                title: `📂 ${doc.data().name.substring(0, 24)}`,
                description: "Toca para ver opciones"
            });
        });

        // 2. Obtener y añadir los productos directos
        if (itemsIds && itemsIds.length > 0) {
            const itemsSnap = await db.collection('menu_items')
                .where(admin.firestore.FieldPath.documentId(), 'in', itemsIds)
                .get();

            itemsSnap.forEach(doc => {
                const data = doc.data();
                let precioStr = "";
                if (data.variants && data.variants.length > 0) {
                    const precios = data.variants.map(v => v.branchPrices?.[branchId] || v.price || 0);
                    const minPrice = Math.min(...precios);
                    precioStr = `Desde $${minPrice}`;
                } else {
                    const precio = data.branchPrices?.[branchId] || data.price || 0;
                    precioStr = `Precio: $${precio}`;
                }

                allRows.push({
                    id: `prod_${doc.id}`,
                    title: data.name.substring(0, 24),
                    description: precioStr
                });
            });
        }

        if (allRows.length === 0) {
            return await enviarMensajeTexto(numero, "No hay opciones disponibles en esta sección por ahora.");
        }

        // Interfaz interactiva de WhatsApp (Solo 8 max + 2 botones utilitarios)
        const targetRows = allRows.slice(offset, offset + 8);

        if (allRows.length > offset + 8) {
            targetRows.push({
                id: `next_${categoryId}_${offset + 8}`,
                title: "➡️ Ver más opciones",
                description: "Desplegar el resto de productos"
            });
        }

        if (offset > 0) {
            targetRows.unshift({
                id: `next_${categoryId}_0`,
                title: "↩️ Volver al inicio",
                description: "Regresar a las primeras opciones"
            });
        }

        // Inyectar Carrito de arranque si existe
        if (cart && cart.length > 0) {
            targetRows.unshift({
                id: 'btn_ver_carrito',
                title: `🛒 Ver Carrito (${cart.length})`,
                description: "Revisar y enviar pedido a cocina"
            });
        }

        const msgTexto = (cart && cart.length > 0) ? "¡Tienes productos en tu carrito!" : `Mostrando opciones para ${categoryName.substring(0, 24)}:`;

        await enviarListaWhatsApp(
            numero,
            categoryName.substring(0, 24),
            msgTexto,
            "Ver Menú",
            targetRows
        );

    } catch (error) {
        console.error("Error al renderizar categoría mixta:", error);
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

async function enviarOpcionesVariantes(numero, productName, variants) {
    const sessionSnap = await db.collection('bot_sessions').doc(numero).get();
    const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';

    const rows = variants.map((v, index) => {
        const precio = v.branchPrices?.[branchId] || v.price || 0;
        return {
            id: `var_${index}`,
            title: v.name.substring(0, 24),
            description: `Precio: $${precio}`
        };
    });

    await enviarListaWhatsApp(
        numero,
        productName.substring(0, 24),
        "Selecciona el tamaño o variante:",
        "Ver Variantes",
        rows.slice(0, 10)
    );
}

async function enviarOpcionesCantidad(numero, productName) {
    await enviarMensajeTexto(
        numero,
        `¿Cuántas unidades de *${productName}* deseas agregar?\n\nPor favor, *escribe un número* (ejemplo: 2).`
    );
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
async function enviarResumenCarrito(numero, cart) {
    let resumen = "🛒 *Tu Carrito de Compras:*\n\n";
    let cuentaTotal = 0;

    cart.forEach((item, index) => {
        resumen += `${index + 1}. *${item.quantity || 1}x ${item.baseName}* - $${item.finalPrice}\n`;
        if (item.details?.selectedModifiers?.length > 0) {
            const nombresMods = item.details.selectedModifiers.map(m => m.name).join(", ");
            resumen += `   _Opciones: ${nombresMods}_\n`;
        }
        resumen += `\n`;
        cuentaTotal += item.finalPrice;
    });

    resumen += `*Total a pagar: $${cuentaTotal}*`;

    // Mandamos el resumen como texto y abajo botones interactivos para proceder
    await enviarMensajeTexto(numero, resumen);

    // Enviar botones para la confirmación del checkout
    await axios({
        method: "POST",
        url: `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`,
        data: {
            messaging_product: "whatsapp",
            to: numero,
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "¿Deseas enviar este pedido a la cocina?" },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "btn_enviar_cocina", title: "🚀 Enviar a Cocina" } },
                        { type: "reply", reply: { id: "cat_root", title: "➕ Agregar Más" } }
                    ]
                }
            }
        },
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.WA_TOKEN}`,
        },
    });
}

async function procesarEnvioKds(numero, cart, sessionRef) {
    try {
        const sessionSnap = await sessionRef.get();
        const branchId = sessionSnap.data()?.branchId || 'wa9igpvRpHkYpT7RPqgu';
        const totalPedido = cart.reduce((sum, item) => sum + item.finalPrice, 0);

        const ordenFinalKds = {
            orderNumber: `WA-${Math.floor(Math.random() * 900) + 100}`,
            customerName: `WhatsApp (${numero.slice(-4)})`,
            status: 'pending',
            paymentMethod: 'TRANSFERENCIA',
            kitchenStatus: 'pending',
            orderMode: 'WhatsApp',
            branchId: branchId,
            createdAt: admin.firestore.Timestamp.now(),
            total: totalPedido,
            items: cart // Enviamos todo el array de TicketItems estructurado de golpe!
        };

        // Guardamos en la colección real de comandas
        await db.collection('orders').add(ordenFinalKds);

        await enviarMensajeTexto(numero, "🎉 ¡Tu pedido ha sido enviado con éxito!\n\n💳 *MÉTODO DE PAGO*\nPor favor envía tu comprobante de transferencia o captura de pago por este medio durante los próximos *10 minutos* para poder autorizar la preparación de tu orden y evitar cancelaciones.");

        // Vaciamos la sesión por completo para el próximo uso
        await sessionRef.delete();

    } catch (error) {
        console.error("Error al inyectar orden final al KDS:", error);
        await enviarMensajeTexto(numero, "Hubo un problema al procesar el cierre del carrito.");
    }
}
// INICIAR EL SERVIDOR
app.listen(PORT, () => console.log(`[WA-BOT] Servidor activo escuchando en puerto ${PORT}`));
