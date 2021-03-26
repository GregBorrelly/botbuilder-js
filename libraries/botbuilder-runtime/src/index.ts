// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as t from 'runtypes';
import fs from 'fs';
import path from 'path';
import { Configuration } from './configuration';
import { ok } from 'assert';

import { AdaptiveComponentRegistration } from 'botbuilder-dialogs-adaptive';
import { ApplicationInsightsTelemetryClient, TelemetryInitializerMiddleware } from 'botbuilder-applicationinsights';
import { BlobsStorage, BlobsTranscriptStore } from 'botbuilder-azure-blobs';
import { ComponentRegistration, SkillConversationIdFactory } from 'botbuilder';
import { ConfigurationResourceExporer } from './configurationResourceExplorer';
import { CoreBot } from './coreBot';
import { CoreBotAdapter } from './coreBotAdapter';
import { CosmosDbPartitionedStorage } from 'botbuilder-azure';
import { IServices, ServiceCollection, TPlugin } from 'botbuilder-runtime-core';
import { LuisComponentRegistration, QnAMakerComponentRegistration } from 'botbuilder-ai';

import {
    AuthenticationConfiguration,
    SimpleCredentialProvider,
    allowedCallersClaimsValidator,
} from 'botframework-connector';

import {
    ConsoleTranscriptLogger,
    ConversationState,
    InspectionMiddleware,
    InspectionState,
    MemoryStorage,
    MiddlewareSet,
    NullTelemetryClient,
    SetSpeakMiddleware,
    ShowTypingMiddleware,
    SkillHandler,
    SkillHttpClient,
    TelemetryLoggerMiddleware,
    TranscriptLoggerMiddleware,
    UserState,
} from 'botbuilder';

function addFeatures(services: ServiceCollection<IServices>, configuration: Configuration): void {
    services.composeFactory(
        'middlewares',
        ['storage', 'conversationState', 'userState'],
        ({ conversationState, storage, userState }, middlewareSet) => {
            if (configuration.bool(['showTyping'])) {
                middlewareSet.use(new ShowTypingMiddleware());
            }

            const setSpeak = configuration.type(
                ['setSpeak'],
                t.Record({
                    voiceFontName: t.String.Or(t.Undefined),
                    lang: t.String,
                    fallbackToTextForSpeechIfEmpty: t.Boolean,
                })
            );

            if (setSpeak) {
                middlewareSet.use(
                    new SetSpeakMiddleware(
                        setSpeak.voiceFontName ?? null,
                        setSpeak.lang,
                        setSpeak.fallbackToTextForSpeechIfEmpty
                    )
                );
            }

            if (configuration.bool(['traceTranscript'])) {
                const blobsTranscript = configuration.type(
                    ['blobTranscript'],
                    t.Record({
                        connectionString: t.String,
                        containerName: t.String,
                    })
                );

                middlewareSet.use(
                    new TranscriptLoggerMiddleware(
                        blobsTranscript
                            ? new BlobsTranscriptStore(blobsTranscript.connectionString, blobsTranscript.containerName)
                            : new ConsoleTranscriptLogger()
                    )
                );
            }

            if (configuration.bool(['useInspection'])) {
                const inspectionState = new InspectionState(storage);
                middlewareSet.use(new InspectionMiddleware(inspectionState, userState, conversationState));
            }

            return middlewareSet;
        }
    );
}

function addTelemetry(services: ServiceCollection<IServices>, configuration: Configuration): void {
    services.addFactory('botTelemetryClient', () => {
        const instrumentationKey = configuration.string(['instrumentationKey']);

        return instrumentationKey
            ? new ApplicationInsightsTelemetryClient(instrumentationKey)
            : new NullTelemetryClient();
    });

    services.addFactory(
        'telemetryMiddleware',
        ['botTelemetryClient'],
        ({ botTelemetryClient }) =>
            new TelemetryInitializerMiddleware(
                new TelemetryLoggerMiddleware(botTelemetryClient, configuration.bool(['logPersonalInformation'])),
                configuration.bool(['logActivities'])
            )
    );
}

function addStorage(services: ServiceCollection<IServices>, configuration: Configuration): void {
    services.addFactory('conversationState', ['storage'], ({ storage }) => new ConversationState(storage));
    services.addFactory('userState', ['storage'], ({ storage }) => new UserState(storage));

    services.addFactory('storage', () => {
        const storage = configuration.string(['runtimeSettings', 'storage']);

        switch (storage) {
            case 'BlobsStorage': {
                const blobsStorage = configuration.type(
                    ['BlobsStorage'],
                    t.Record({
                        connectionString: t.String,
                        containerName: t.String,
                    })
                );

                ok(blobsStorage);

                return new BlobsStorage(blobsStorage.connectionString, blobsStorage.containerName);
            }

            case 'CosmosDbPartitionedStorage': {
                const cosmosOptions = configuration.type(
                    ['CosmosDbPartitionedStorage'],
                    t.Record({
                        authKey: t.String.Or(t.Undefined),
                        compatibilityMode: t.Boolean.Or(t.Undefined),
                        containerId: t.String,
                        containerThroughput: t.Number.Or(t.Undefined),
                        cosmosDbEndpoint: t.String.Or(t.Undefined),
                        databaseId: t.String,
                        keySuffix: t.String.Or(t.Undefined),
                    })
                );

                ok(cosmosOptions);

                return new CosmosDbPartitionedStorage(cosmosOptions);
            }

            default:
                return new MemoryStorage();
        }
    });
}

function addSkills(services: ServiceCollection<IServices>, configuration: Configuration): void {
    services.addInstance('credentialProvider', new SimpleCredentialProvider('appId', 'appPassword'));

    services.addFactory(
        'skillConversationIdFactory',
        ['storage'],
        ({ storage }) => new SkillConversationIdFactory(storage)
    );

    services.addFactory(
        'skillClient',
        ['credentialProvider', 'skillConversationIdFactory'],
        ({ credentialProvider, skillConversationIdFactory }) =>
            new SkillHttpClient(credentialProvider, skillConversationIdFactory)
    );

    services.addFactory('authenticationConfiguration', () => {
        const allowedCallers = configuration.type(['allowedCallers'], t.Array(t.String)) ?? [];

        return new AuthenticationConfiguration(
            undefined,
            allowedCallers.length ? allowedCallersClaimsValidator(allowedCallers) : undefined
        );
    });

    services.addFactory(
        'channelServiceHandler',
        ['adapter', 'bot', 'skillConversationIdFactory', 'credentialProvider', 'authenticationConfiguration'],
        (dependencies) =>
            new SkillHandler(
                dependencies.adapter,
                dependencies.bot,
                dependencies.skillConversationIdFactory,
                dependencies.credentialProvider,
                dependencies.authenticationConfiguration
            )
    );
}

function addCoreBot(services: ServiceCollection<IServices>, configuration: Configuration): void {
    services.addFactory(
        'bot',
        [
            'resourceExplorer',
            'userState',
            'conversationState',
            'skillClient',
            'skillConversationIdFactory',
            'botTelemetryClient',
        ],
        (dependencies) =>
            new CoreBot(
                dependencies.resourceExplorer,
                dependencies.userState,
                dependencies.conversationState,
                dependencies.skillClient,
                dependencies.skillConversationIdFactory,
                dependencies.botTelemetryClient,
                configuration.string(['defaultLocale']) ?? 'en-US',
                configuration.string(['defaultRootDialog']) ?? 'main.dialog'
            )
    );

    services.addFactory(
        'adapter',
        ['authenticationConfiguration', 'conversationState', 'userState', 'middlewares', 'telemetryMiddleware'],
        (dependencies) => {
            const adapter = new CoreBotAdapter(
                dependencies.authenticationConfiguration,
                dependencies.conversationState,
                dependencies.userState
            );

            adapter.use(dependencies.middlewares);
            adapter.use(dependencies.telemetryMiddleware);

            return adapter;
        }
    );
}

async function addPlugins(services: ServiceCollection<IServices>, configuration: Configuration): Promise<void> {
    const loadPlugin = async (name: string): Promise<TPlugin | undefined> => {
        try {
            const plugin = (await import(name))?.default;

            if (plugin) {
                ok(typeof plugin === 'function', `Failed to load ${name}`);
                return plugin;
            }
        } catch (_err) {
            // no-op
        }

        return undefined;
    };

    const plugins =
        configuration.type(
            ['runtimeSettings', 'plugins'],
            t.Array(
                t.Record({
                    name: t.String,
                    settingsPrefix: t.String.Or(t.Undefined),
                })
            )
        ) ?? [];

    for (const { name, settingsPrefix } of plugins) {
        const plugin = await loadPlugin(name);
        ok(plugin);

        await Promise.resolve(plugin(services, configuration.bind([settingsPrefix ?? name])));
    }
}

async function normalizeConfiguration(configuration: Configuration, applicationRoot: string): Promise<void> {
    // Override applicationRoot setting
    configuration.set(['applicationRoot'], applicationRoot);

    // Override root dialog setting
    configuration.set(
        ['defaultRootDialog'],
        await new Promise<string | undefined>((resolve, reject) =>
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            fs.readdir(applicationRoot, (err, files) =>
                err ? reject(err) : resolve(files.find((file) => file.endsWith('.dialog')))
            )
        )
    );
}

/**
 * Construct all runtime services.
 *
 * @param applicationRoot absolute path to root of application
 * @param configuration a fully initialized configuration instance to use
 * @returns service collection and configuration
 */
export async function getRuntimeServices(
    applicationRoot: string,
    configuration: Configuration
): Promise<[ServiceCollection<IServices>, Configuration]>;

/**
 * Construct all runtime services.
 *
 * @param applicationRoot absolute path to root of application
 * @param settingsDirectory directory where settings files are located
 * @returns service collection and configuration
 */
export async function getRuntimeServices(
    applicationRoot: string,
    settingsDirectory: string
): Promise<[ServiceCollection<IServices>, Configuration]>;

/**
 * @internal
 */
export async function getRuntimeServices(
    applicationRoot: string,
    configurationOrSettingsDirectory: Configuration | string
): Promise<[ServiceCollection<IServices>, Configuration]> {
    ComponentRegistration.add(new AdaptiveComponentRegistration());
    ComponentRegistration.add(new QnAMakerComponentRegistration());
    ComponentRegistration.add(new LuisComponentRegistration());

    // Resolve configuration
    let configuration: Configuration;
    if (typeof configurationOrSettingsDirectory === 'string') {
        configuration = new Configuration()
            .argv()
            .env()
            .file(path.join(configurationOrSettingsDirectory, 'appsettings.Development.json'))
            .file(path.join(configurationOrSettingsDirectory, 'appsettings.json'));
    } else {
        configuration = configurationOrSettingsDirectory;
    }

    await normalizeConfiguration(configuration, applicationRoot);

    const services = new ServiceCollection<IServices>({
        componentRegistration: ComponentRegistration,
        customAdapters: new Map(),
        middlewares: new MiddlewareSet(),
    });

    services.addFactory(
        'resourceExplorer',
        ['componentRegistration'], // implicit dependency
        () => new ConfigurationResourceExporer(configuration)
    );

    const runtimeSettings = configuration.bind(['runtimeSettings']);

    addCoreBot(services, configuration);
    addFeatures(services, runtimeSettings.bind(['features']));
    addSkills(services, runtimeSettings.bind(['skills']));
    addStorage(services, configuration);
    addTelemetry(services, runtimeSettings.bind(['telemetry']));
    await addPlugins(services, configuration);

    return [services, configuration];
}

export { Configuration };