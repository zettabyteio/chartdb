import { Dialog, DialogContent } from '@/components/dialog/dialog';
import { useDialog } from '@/hooks/use-dialog';
import { DatabaseType } from '@/lib/domain/database-type';
import React, { useCallback, useEffect, useState } from 'react';
import { ImportDatabase } from '../common/import-database/import-database';
import type { DatabaseEdition } from '@/lib/domain/database-edition';
import { useChartDB } from '@/hooks/use-chartdb';
import { useRedoUndoStack } from '@/hooks/use-redo-undo-stack';
import { useTranslation } from 'react-i18next';
import type { BaseDialogProps } from '../common/base-dialog-props';
import type { ImportMethod } from '@/lib/import-method/import-method';
import { importContentToDiagram } from '@/lib/import-method/import-content';
import { getImportOffsetX, offsetTablesX } from '@/lib/utils/import-offset';

export interface ImportDatabaseDialogProps extends BaseDialogProps {
    databaseType: DatabaseType;
    importMethods?: ImportMethod[];
    initialImportMethod?: ImportMethod;
}

const defaultImportMethods: ImportMethod[] = ['query', 'ddl', 'dbml'];

export const ImportDatabaseDialog: React.FC<ImportDatabaseDialogProps> = ({
    dialog,
    databaseType,
    importMethods = defaultImportMethods,
    initialImportMethod,
}) => {
    const [importMethod, setImportMethod] = useState<ImportMethod>(
        initialImportMethod ?? importMethods[0]
    );
    const { closeImportDatabaseDialog } = useDialog();
    const {
        addTables,
        addRelationships,
        diagramName,
        databaseType: currentDatabaseType,
        updateDatabaseType,
        tables: existingTables,
    } = useChartDB();
    const [scriptResult, setScriptResult] = useState('');
    const { resetRedoStack, resetUndoStack } = useRedoUndoStack();
    const { t } = useTranslation();
    const [databaseEdition, setDatabaseEdition] = useState<
        DatabaseEdition | undefined
    >();

    useEffect(() => {
        setDatabaseEdition(undefined);
    }, [databaseType]);

    useEffect(() => {
        if (!dialog.open) return;
        setDatabaseEdition(undefined);
        setScriptResult('');
        setImportMethod(initialImportMethod ?? importMethods[0]);
    }, [dialog.open, importMethods, initialImportMethod]);

    const importDatabase = useCallback(async () => {
        const diagram = await importContentToDiagram({
            method: importMethod,
            content: scriptResult,
            databaseType,
            databaseEdition,
        });

        // Skip if nothing to import
        const newTablesNumber = diagram.tables?.length ?? 0;
        const newRelationshipsNumber = diagram.relationships?.length ?? 0;
        if (newTablesNumber === 0 && newRelationshipsNumber === 0) {
            return;
        }

        // Close dialog immediately to prevent re-render blocking
        closeImportDatabaseDialog();

        // Apply offset to imported tables so they land right of existing ones
        const positionedTables = offsetTablesX(
            diagram.tables ?? [],
            getImportOffsetX(existingTables)
        );

        // Use queueMicrotask to defer work after dialog closes but before next paint
        queueMicrotask(async () => {
            // Add tables and relationships
            await Promise.all([
                addTables(positionedTables, { updateHistory: false }),
                addRelationships(diagram.relationships ?? [], {
                    updateHistory: false,
                }),
            ]);

            if (currentDatabaseType === DatabaseType.GENERIC) {
                await updateDatabaseType(databaseType);
            }

            // Reset undo/redo stacks
            resetRedoStack();
            resetUndoStack();
        });
    }, [
        importMethod,
        databaseEdition,
        currentDatabaseType,
        updateDatabaseType,
        databaseType,
        scriptResult,
        addRelationships,
        addTables,
        resetRedoStack,
        resetUndoStack,
        closeImportDatabaseDialog,
        existingTables,
    ]);

    return (
        <Dialog
            {...dialog}
            onOpenChange={(open) => {
                if (!open) {
                    closeImportDatabaseDialog();
                }
            }}
        >
            <DialogContent
                className="flex max-h-screen w-full flex-col md:max-w-[900px]"
                showClose
            >
                <ImportDatabase
                    databaseType={databaseType}
                    databaseEdition={databaseEdition}
                    setDatabaseEdition={setDatabaseEdition}
                    onImport={importDatabase}
                    scriptResult={scriptResult}
                    setScriptResult={setScriptResult}
                    keepDialogAfterImport
                    title={t('import_database_dialog.title', { diagramName })}
                    importMethod={importMethod}
                    setImportMethod={setImportMethod}
                    importMethods={importMethods}
                />
            </DialogContent>
        </Dialog>
    );
};
