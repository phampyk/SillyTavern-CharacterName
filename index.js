/**
 * Chat Name Extension for SillyTavern
 * 
 * Allows setting a separate "Character Name" for chat display and {{char}} macro
 * that differs from the card name.
 * 
 * Use Case:
 * - JanitorAI imports often have descriptive card names: "Merrick | The Fool's Gambit"
 * - This extension lets you use "Merrick" in chat/prompts while keeping the full card name
 * 
 * Storage:
 * - Chat name stored in: character.data.extensions['chat-name'].chatName
 * 
 * @author Your Name
 * @version 1.0.0
 */

(function() {
    'use strict';
    
    // ============================================================================
    // Constants
    // ============================================================================
    
    const EXTENSION_NAME = 'chat-name';
    const LOG_PREFIX = '[chat-name]';
    const INIT_TIMEOUT = 10000; // 10 seconds max wait for context
    const INIT_CHECK_INTERVAL = 100; // Check every 100ms
    
    // ============================================================================
    // State
    // ============================================================================
    
    let initialized = false;
    let eventListenersAttached = false;
    
    // ============================================================================
    // Utility Functions
    // ============================================================================
    
    /**
     * Get SillyTavern context
     * @returns {Object|null} SillyTavern context or null
     */
    function getContext() {
        return window.SillyTavern?.getContext?.() ?? null;
    }
    
    /**
     * Get current character
     * @returns {Object|null} Character object or null
     */
    function getCurrentCharacter() {
        const ctx = getContext();
        if (!ctx || ctx.characterId === undefined) {
            return null;
        }
        return ctx.characters[ctx.characterId] ?? null;
    }
    
    /**
     * Get chat name for current character, fallback to card name
     * @returns {string} Chat name or card name
     */
    function getChatName() {
        const char = getCurrentCharacter();
        if (!char) {
            return '';
        }
        
        const chatName = char.data?.extensions?.[EXTENSION_NAME]?.chatName;
        const trimmedChatName = chatName?.trim();
        
        return trimmedChatName || char._originalName || char.name || '';
    }
    
    // ============================================================================
    // UI Functions
    // ============================================================================
    
    /**
     * Add chat name input field to character editor
     */
    function addInputField() {
        // Prevent duplicates
        if (document.getElementById('chat_name_input')) {
            return;
        }
        
        const tagsDiv = document.querySelector('#tags_div');
        if (!tagsDiv) {
            console.warn(LOG_PREFIX, 'Cannot find #tags_div element');
            return;
        }
        
        const fieldHTML = `
            <div id="chat_name_block">
                <label for="chat_name_input">
                    <small>Character Name (for chat/{{char}})</small>
                </label>
                <input id="chat_name_input" 
                       class="text_pole" 
                       type="text" 
                       placeholder="Leave empty to use card name" 
                       maxlength="100" />
            </div>
        `;
        
        tagsDiv.insertAdjacentHTML('beforebegin', fieldHTML);
        
        // Attach event listener
        const input = document.getElementById('chat_name_input');
        if (input) {
            input.addEventListener('input', handleInputChange);
            loadChatNameToField();
        }
    }
    
    /**
     * Handle input field changes
     */
    function handleInputChange() {
        const ctx = getContext();
        const input = document.getElementById('chat_name_input');
        
        if (!ctx || ctx.characterId === undefined || !input) {
            return;
        }
        
        // Save to character extension data
        ctx.writeExtensionField(ctx.characterId, EXTENSION_NAME, {
            chatName: input.value
        });
    }
    
    /**
     * Load chat name into input field
     */
    function loadChatNameToField() {
        const input = document.getElementById('chat_name_input');
        if (!input) {
            return;
        }
        
        const char = getCurrentCharacter();
        if (!char) {
            input.value = '';
            return;
        }
        
        input.value = char.data?.extensions?.[EXTENSION_NAME]?.chatName || '';
    }
    
    // ============================================================================
    // Macro Override
    // ============================================================================
    
    /**
     * Hook the character's name property ONLY for macro substitution
     * Uses a call stack check to avoid affecting chat naming
     */
    function hookCharacterName() {
        const char = getCurrentCharacter();
        if (!char) {
            return;
        }
        
        // Don't re-hook if already hooked
        if (char._chatNameHooked) {
            return;
        }
        
        // Store original name
        if (!char._originalName) {
            char._originalName = char.name;
        }
        
        // Define property with smart getter/setter
        Object.defineProperty(char, 'name', {
            get: function() {
                // Check if we're being called from macro substitution
                const stack = new Error().stack;
                const isFromMacros = stack && (
                    stack.includes('evaluateMacros') ||
                    stack.includes('substituteParams') ||
                    stack.includes('MacrosParser')
                );
                
                // Only return chat name if called from macro system
                if (isFromMacros) {
                    const chatName = this.data?.extensions?.[EXTENSION_NAME]?.chatName;
                    const trimmedChatName = chatName?.trim();
                    if (trimmedChatName) {
                        return trimmedChatName;
                    }
                }
                
                // Otherwise return original name (for chat naming, UI, etc)
                return this._originalName;
            },
            set: function(value) {
                this._originalName = value;
            },
            configurable: true,
            enumerable: true
        });
        
        char._chatNameHooked = true;
    }
    
    /**
     * Register {{char}} macro in available macro systems
     * This is a fallback for systems that don't use the character object
     */
    function registerMacroOverrides() {
        const ctx = getContext();
        if (!ctx) {
            return;
        }
        
        // Method 1: New macro system (experimental macro engine)
        if (window.macros?.registry) {
            try {
                if (window.macros.registry.hasMacro('char')) {
                    window.macros.registry.unregisterMacro('char');
                }
                window.macros.registry.registerMacro('char', {
                    category: 'core',
                    description: 'Character name (overridden by chat-name extension)',
                    handler: getChatName,
                });
                console.log(LOG_PREFIX, 'Registered in new macro system');
            } catch (error) {
                console.warn(LOG_PREFIX, 'Failed to register in new macro system:', error);
            }
        }
        
        // Method 2: Old deprecated system for compatibility
        if (ctx.registerMacro) {
            try {
                ctx.registerMacro('char', getChatName);
                console.log(LOG_PREFIX, 'Registered in old macro system');
            } catch (error) {
                console.warn(LOG_PREFIX, 'Failed to register in old macro system:', error);
            }
        }
        
        // Method 3: Hook character name (most reliable for macro substitution)
        hookCharacterName();
    }
    
    // ============================================================================
    // Event Handlers
    // ============================================================================
    
    /**
     * Handle character or chat changes
     */
    function handleCharacterChange() {
        addInputField();
        loadChatNameToField();
        hookCharacterName();
    }
    
    /**
     * Attach event listeners
     * @param {Object} ctx - SillyTavern context
     */
    function attachEventListeners(ctx) {
        if (eventListenersAttached || !ctx.eventSource || !ctx.event_types) {
            return;
        }
        
        ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, handleCharacterChange);
        ctx.eventSource.on(ctx.event_types.CHARACTER_SELECTED, handleCharacterChange);
        
        eventListenersAttached = true;
    }
    
    // ============================================================================
    // Initialization
    // ============================================================================
    
    /**
     * Initialize the extension
     * @param {Object} ctx - SillyTavern context
     */
    function initialize(ctx) {
        if (initialized) {
            return;
        }
        
        console.log(LOG_PREFIX, 'Initializing extension...');
        
        // Add UI field
        addInputField();
        
        // Register macro overrides
        registerMacroOverrides();
        
        // Attach event listeners
        attachEventListeners(ctx);
        
        initialized = true;
        console.log(LOG_PREFIX, 'Extension initialized successfully');
    }
    
    /**
     * Wait for SillyTavern context to be available
     */
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
                console.error(LOG_PREFIX, 'Failed to initialize: SillyTavern context not found');
            }
        }, INIT_CHECK_INTERVAL);
    }
    
    // ============================================================================
    // Entry Point
    // ============================================================================
    
    // Wait for jQuery and start initialization
    if (typeof jQuery !== 'undefined') {
        jQuery(waitForContext);
    } else {
        console.error(LOG_PREFIX, 'jQuery not found, extension cannot initialize');
    }
    
})();
