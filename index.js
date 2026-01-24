(function() {
    'use strict';
    
    // ============================================================================
    // Constants
    // ============================================================================
    
    const EXTENSION_NAME = 'chat-name';
    const LOG_PREFIX = '[chat-name]';
    const INIT_TIMEOUT = 10000;
    const INIT_CHECK_INTERVAL = 100;
    
    // ============================================================================
    // State
    // ============================================================================
    
    let initialized = false;
    let eventListenersAttached = false;
    let chatObserver = null;
    let nameCache = new Map(); // Cache chatName by character avatar/name
    let processedMessages = new WeakSet(); // Track messages with persistent name overrides
    let pendingUpdates = new Set(); // Set of message IDs pending name update
    
    // ============================================================================
    // Utility Functions
    // ============================================================================
    
    // Get SillyTavern context
    function getContext() {
        return window.SillyTavern?.getContext?.() ?? null;
    }
    
    // Get character data for a character's avatar key or name
    function getCharacterForMessage(message) {
        const ctx = getContext();
        if (!ctx || !ctx.characters || !message) return null;
        
        const avatar = message.avatar || message.force_avatar || message.original_avatar;
        const name = (message.name || '').trim();

        // Helper to normalize avatar string for comparison
        const normalizeAvatar = (str) => {
            if (!str) return '';
            // Remove path and query params, but keep filename with extension
            let normalized = str.split('/').pop().split('?')[0];
            return decodeURIComponent(normalized);
        };

        const normalizedAvatar = normalizeAvatar(avatar);

        // 1. Try matching by normalized avatar
        if (normalizedAvatar) {
            const avatarMatch = ctx.characters.find(c => normalizeAvatar(c.avatar) === normalizedAvatar);
            if (avatarMatch) return avatarMatch;
        }

        // 2. Try matching by original_avatar (fallback for group chats)
        if (message.original_avatar) {
            const normOrig = normalizeAvatar(message.original_avatar);
            const originalMatch = ctx.characters.find(c => normalizeAvatar(c.avatar) === normOrig);
            if (originalMatch) return originalMatch;
        }
        
        // 3. Try matching by name (exact match fallback)
        if (name) {
            const nameMatch = ctx.characters.find(c => c.name === name);
            if (nameMatch) return nameMatch;
            
            // 3b. Try fuzzy name match (one contains the other) - helps with "Name - Filename" cases
            const fuzzyMatch = ctx.characters.find(c => {
                const charName = (c.name || '').trim();
                return charName.length > 2 && (name.includes(charName) || charName.includes(name));
            });
            if (fuzzyMatch) return fuzzyMatch;
        }

        // 4. Last resort fallback for 1-on-1 chats: use current character
        if (ctx.characterId !== undefined && !ctx.groupId) {
            return ctx.characters[ctx.characterId] ?? null;
        }
        
        return null;
    }

    // Get the character currently selected for editing/sidebar
    function getSelectedCharacter() {
        const ctx = getContext();
        if (!ctx || ctx.characterId === undefined) return null;
        return ctx.characters[ctx.characterId] ?? null;
    }
    
    // Get chat name for a specific character object, fallback to card name
    function getChatName(character) {
        if (!character) return '';
        const customName = character.data?.extensions?.[EXTENSION_NAME]?.chatName;
        return customName?.trim() || character.name || '';
    }
    
    // ============================================================================
    // UI Functions
    // ============================================================================
    
    // Apply persistent .name property override on a message object
    function applyPersistentName(message, chatName) {
        if (!message || processedMessages.has(message) || !chatName) return;

        try {
            let originalName = message.name;
            Object.defineProperty(message, 'name', {
                get: () => chatName || originalName,
                set: (val) => { originalName = val; },
                configurable: true,
                enumerable: true
            });
            processedMessages.add(message);
        } catch (e) {
            message.name = chatName; // Fallback
        }
    }

    // Sync naming data across SillyTavern's memory
    function syncChatData() {
        const ctx = getContext();
        if (!ctx || !ctx.chat) return;

        // 1. Override name2 (current character) for 1-on-1 chats
        if (ctx.characterId !== undefined && !ctx.groupId) {
            const char = ctx.characters[ctx.characterId];
            const chatName = getChatName(char);
            if (chatName && ctx.name2 !== chatName) {
                window.SillyTavern.getContext().name2 = chatName;
            }
        }

        // 2. Override all messages in the chat array
        ctx.chat.forEach((message, id) => {
            if (!message || message.is_user || message.is_system) return;
            
            const cacheKey = message.avatar || message.force_avatar || message.original_avatar || message.name;
            let chatName = nameCache.get(cacheKey);
            
            if (chatName === undefined) {
                const character = getCharacterForMessage(message);
                chatName = getChatName(character);
                if (cacheKey) nameCache.set(cacheKey, chatName);
            }

            if (chatName) {
                applyPersistentName(message, chatName);
                updateUIName(id);
            }
        });
    }

    // Update chat bubble name text in the DOM
    function updateUIName(messageId) {
        const ctx = getContext();
        if (!ctx || !ctx.chat) return;

        const message = ctx.chat[messageId];
        if (!message || message.is_user || message.is_system) return;

        const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (messageElement) {
            applyNameOverrideToElement(messageElement, message.name);
        }
    }

    // Apply the override to a specific message DOM element
    function applyNameOverrideToElement(messageElement, chatName) {
        const selectors = ['.ch_name .name_text', '.mes_header .name', '.ch_name', '.name_text', '.mes_name', '.mesHeader_name', '.ch_name span', '.mes_header span'];
        
        for (const selector of selectors) {
            const nameElement = messageElement.querySelector(selector);
            if (nameElement) {
                if (nameElement.children.length === 0) {
                    if (nameElement.textContent !== chatName) nameElement.textContent = chatName;
                    break;
                } else {
                    for (const child of nameElement.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE && child.textContent.trim().length > 0) {
                            if (child.textContent.trim() !== chatName) child.textContent = chatName;
                            return; // Found and updated
                        }
                    }
                }
            }
        }
    }

    // Scan all messages and update names
    function updateAllNames() {
        nameCache.clear();
        syncChatData();
    }

    // Setup MutationObserver to watch for chat updates
    function setupChatObserver() {
        const chatContainer = document.getElementById('chat');
        if (!chatContainer || chatObserver) return;

        chatObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                let target = mutation.target;
                if (target.nodeType === Node.TEXT_NODE) target = target.parentElement;
                if (!target) continue;

                const messageElement = target.closest?.('.mes') || (mutation.addedNodes[0]?.closest?.('.mes'));
                if (messageElement) {
                    const mesId = messageElement.getAttribute('mesid');
                    if (mesId !== null) updateUIName(Number(mesId));
                }
            }
        });

        chatObserver.observe(chatContainer, { childList: true, subtree: true, characterData: true });
        console.log(LOG_PREFIX, 'Chat observer started');
    }

    // Add input field to the character editor sidebar
    function addInputField() {
        if (document.getElementById('chat_name_input')) return;
        
        const tagsDiv = document.querySelector('#tags_div');
        if (!tagsDiv) return;
        
        const fieldHTML = `
            <div id="chat_name_block">
                <label for="chat_name_input"><small>Character Name (for {{char}})</small></label>
                <input id="chat_name_input" class="text_pole" type="text" placeholder="Leave empty to use card name" maxlength="100" />
            </div>
        `;
        tagsDiv.insertAdjacentHTML('beforebegin', fieldHTML);
        
        const input = document.getElementById('chat_name_input');
        if (input) {
            input.addEventListener('input', () => {
                const ctx = getContext();
                if (ctx && ctx.characterId !== undefined) {
                    ctx.writeExtensionField(ctx.characterId, EXTENSION_NAME, { chatName: input.value });
                }
            });
            loadChatNameToField();
        }
    }
    
    // Load stored chat name into the editor input field
    function loadChatNameToField() {
        const input = document.getElementById('chat_name_input');
        if (!input) return;
        
        const char = getSelectedCharacter();
        input.value = char?.data?.extensions?.[EXTENSION_NAME]?.chatName || '';
    }
    
    // ============================================================================
    // Core Overrides
    // ============================================================================
    
    // Ensure the custom name is used during prompt build (fallback for name2)
    function handleGenerateBeforePrompt(data) {
        const selectedChar = getSelectedCharacter();
        const chatName = getChatName(selectedChar);
        if (chatName && data.name2) {
            data.name2 = chatName;
        }
    }

    // Register {{char}} macro overrides
    function registerMacroOverrides() {
        const ctx = getContext();
        if (!ctx) return;
        
        const nameGetter = () => getChatName(getSelectedCharacter());

        // New Macro Engine
        if (ctx.macros) {
            try {
                if (ctx.macros.registry.hasMacro('char')) ctx.macros.registry.unregisterMacro('char');
                ctx.macros.registry.registerMacro('char', {
                    category: 'core',
                    description: 'Character name override',
                    handler: nameGetter,
                });

                if (ctx.macros.envBuilder?.registerProvider) {
                    ctx.macros.envBuilder.registerProvider((env) => {
                        const name = nameGetter();
                        if (name) env.names.char = name;
                    });
                }
            } catch (e) {
                console.warn(LOG_PREFIX, 'Macro registration failed', e);
            }
        }
        
        // Legacy Macro System
        if (ctx.registerMacro) {
            try {
                ctx.registerMacro('char', nameGetter);
            } catch (e) {}
        }
    }
    
    // ============================================================================
    // Lifecycle
    // ============================================================================
    
    function handleCharacterChange() {
        addInputField();
        loadChatNameToField();
        updateAllNames();
        setupChatObserver();
    }
    
    function attachEventListeners(ctx) {
        if (eventListenersAttached || !ctx.eventSource || !ctx.eventTypes) return;
        const events = ctx.eventSource;
        const types = ctx.eventTypes;

        // Data-level sync for persistence
        events.on(types.CHARACTER_MESSAGE_RENDERED, syncChatData);
        events.on(types.MESSAGE_UPDATED, syncChatData);
        events.on(types.MESSAGE_RECEIVED, syncChatData);
        events.on(types.STREAM_TOKEN_RECEIVED, syncChatData);
        
        events.on(types.GENERATE_BEFORE_COMBINE_PROMPTS, handleGenerateBeforePrompt);
        events.on(types.CHAT_CHANGED, handleCharacterChange);
        events.on(types.CHARACTER_SELECTED, handleCharacterChange);
        
        eventListenersAttached = true;
    }
    
    function initialize(ctx) {
        if (initialized) return;
        addInputField();
        registerMacroOverrides();
        attachEventListeners(ctx);
        setupChatObserver();
        updateAllNames();
        initialized = true;
        console.log(LOG_PREFIX, 'Initialized');
    }
    
    function waitForContext() {
        let attempts = 0;
        const maxAttempts = INIT_TIMEOUT / INIT_CHECK_INTERVAL;
        const intervalId = setInterval(() => {
            attempts++;
            const ctx = getContext();
            if (ctx) {
                clearInterval(intervalId);
                initialize(ctx);
            } else if (attempts >= maxAttempts) {
                clearInterval(intervalId);
                console.error(LOG_PREFIX, 'Failed to find context');
            }
        }, INIT_CHECK_INTERVAL);
    }
    
    if (typeof jQuery !== 'undefined') {
        jQuery(waitForContext);
    }
})();
