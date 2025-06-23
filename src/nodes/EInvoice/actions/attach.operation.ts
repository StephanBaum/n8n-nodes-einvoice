import type { IExecuteFunctions, INodeExecutionData, INodeProperties, IBinaryData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { generateXRechnungXML, createPdfStub } from '../utils/einvoice';

export const properties: INodeProperties[] = [
    {
        displayName: 'Input Binary Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        required: true,
        placeholder: 'e.g. data',
    },
    {
        displayName: 'XML Filename',
        name: 'filename',
        type: 'string',
        default: 'xrechnung.xml',
    },
    {
        displayName: 'Attach PDF layer',
        name: 'attachPdf',
        type: 'boolean',
        default: false,
    },
];

export const description = properties;

export async function execute(this: IExecuteFunctions, items: INodeExecutionData[]) {
    const returnData: INodeExecutionData[] = [];
    for (let index = 0; index < items.length; index++) {
        try {
            const binaryPropertyName = this.getNodeParameter('binaryPropertyName', index) as string;
            const filename = this.getNodeParameter('filename', index) as string;
            const attachPdf = this.getNodeParameter('attachPdf', index) as boolean;
            const invoiceData = items[index]!.json as any;

            const xml = generateXRechnungXML(invoiceData as any);
            let binary: IBinaryData;
            if (attachPdf) {
                const buffer = await createPdfStub(xml, filename);
                binary = await this.helpers.prepareBinaryData(buffer, filename.replace(/\.xml$/, '.pdf'), 'application/pdf');
            } else {
                binary = await this.helpers.prepareBinaryData(Buffer.from(xml), filename, 'application/xml');
            }

            returnData.push({
                json: invoiceData,
                binary: {
                    [binaryPropertyName]: binary,
                },
                pairedItem: { item: index },
            });
        } catch (error) {
            if (this.continueOnFail()) {
                returnData.push({
                    json: { error: (error as Error).message },
                    pairedItem: { item: index },
                });
                continue;
            }
            throw new NodeOperationError(this.getNode(), error, { itemIndex: index });
        }
    }
    return returnData;
}
