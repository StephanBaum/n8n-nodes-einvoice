import type { IExecuteFunctions } from 'n8n-workflow';
import { BINARY_ENCODING } from 'n8n-workflow';

// @ts-ignore
import { stringToPDFString } from 'pdfjs-dist/lib/shared/util';
import { getDocument as readPDF } from 'pdfjs-dist';
import { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

import { Parser } from 'xml2js';
import { PDFDocument } from 'pdf-lib';

import { DOCUMENT_TYPES } from '../types/documentTypes';
import { EInvoice, PostalAddress, TaxRegistration } from '../types/eInvoice';
import { LoggerProxy as logger } from 'n8n-workflow';

export type InvoiceProfile =
  | 'minimum'
  | 'basicwl'
  | 'basic'
  | 'en16931'
  | 'extended'
  | 'zugferd-21'
  | 'xrechnung';

const PROFILE_MAP: Record<string, InvoiceProfile> = {
  'urn:factur-x.eu:1p0:minimum': 'minimum',
  'urn:factur-x.eu:1p0:basicwl': 'basicwl',
  'urn:factur-x.eu:1p0:basic': 'basic',
  'urn:cen.eu:en16931:2017:compliant:factur-x.eu:1p0:basic': 'basic',
  'urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:basic': 'basic',
  'urn:cen.eu:en16931:2017': 'en16931',
  'urn:factur-x.eu:1p0:extended': 'extended',
  'urn:cen.eu:en16931:2017:compliant:factur-x.eu:1p0:extended': 'extended',
  'urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended': 'extended',
  'urn:zugferd.de:2p1': 'zugferd-21',
  'urn:factur-x.eu:2p1:minimum': 'zugferd-21',
  'urn:xoev-de:kosit:standard:xrechnung_2p3': 'xrechnung',
  'urn:cen.eu:en16931:2017#compliant#xrechnung': 'xrechnung',
};

export function resolveProfileId(urn: string): InvoiceProfile {
  const profile = PROFILE_MAP[urn];
  if (!profile) {
    logger.warn(`Unknown invoice profile: ${urn}`);
    return 'en16931';
  }
  return profile;
}

const FACTUR_X_FILENAMES = ["factur-x.xml", "factur\\055x\\056xml", "zugferd-invoice.xml", "zugferd\\055invoice\\056xml", "ZUGFeRD-invoice.xml", "ZUGFeRD\\055invoice\\056xml", "xrechnung.xml", "xrechnung\\056xml"].map(
    (name) => stringToPDFString(name),
);

type Attachment = {
    content: Uint8Array;
    filename: string;
}

/*
 * Extracts embedded XML invoice data from PDF files that follow the Factur-X/ZUGFeRD standard.
 * The function searches for XML attachments with specific filenames (factur-x.xml, zugferd-invoice.xml etc.)
 * and parses them into a JSON object.
 */
export async function extractEInvoiceFromPDF(
    this: IExecuteFunctions,
    binaryPropertyName: string,
    password: string,
    mode: 'json' | 'xml' | 'simple',
    itemIndex = 0,
) {
    const binaryData = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
    
    const params: DocumentInitParameters = { password, isEvalSupported: false };
    
    if (binaryData.id) {
        params.data = await this.helpers.binaryToBuffer(
            await this.helpers.getBinaryStream(binaryData.id),
        );
    } else {
        params.data = Buffer.from(binaryData.data, BINARY_ENCODING).buffer;
    }

    const pdf = await readPDF(params).promise;
    const attachments = await pdf.getAttachments() as Record<string, Attachment>;

    for (const [filename, attachment] of Object.entries(attachments)) {
        if (FACTUR_X_FILENAMES.includes(filename)) {
            const xml = Buffer.from(attachment.content).toString('utf-8');
            if(xml === "") {
                throw new Error("empty xml-attachment in pdf");
            }

            if(mode === 'xml') {
                // give it as xml back, raw
                return {
                    xml: Buffer.from(xml).toString('base64'),
                    filename: attachment.filename,
                };
            }

            return parseEInvoiceXML(xml, mode);
        }
    }
    
    throw new Error("Could not find xml-attachment in pdf");
}

/*
 * Extracts embedded XML invoice data from XML files.
 * The function reads the XML file and parses it into a JSON object.
 */
export async function extractEInvoiceFromXML(
    this: IExecuteFunctions,
    binaryPropertyName: string,
    mode: 'json' | 'xml' | 'simple',
    itemIndex = 0,
) {
    const binaryData = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);
    let data = {} as any;
    if (binaryData.id) {
        data = await this.helpers.binaryToBuffer(
            await this.helpers.getBinaryStream(binaryData.id),
        );
    } else {
        data = Buffer.from(binaryData.data, BINARY_ENCODING).toString('utf-8');
    }

    if(mode === 'xml') {
        return {
            xml: data,
            filename: binaryData.filename,
        };
    }

  return parseEInvoiceXML(data, mode);
}

export function generateXRechnungXML(data: EInvoice): string {
  const escape = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  const fmt = (n: number) => n.toFixed(2);

  const noteXml = (data.notes || [])
    .map(
      (n) =>
        `<ram:IncludedNote><ram:Content>${escape(n.text)}</ram:Content>${n.code ? `<ram:SubjectCode>${escape(n.code)}</ram:SubjectCode>` : ''}</ram:IncludedNote>`,
    )
    .join('');

  const postal = (addr: PostalAddress) => `
      ${addr.address[0] ? `<ram:LineOne>${escape(addr.address[0])}</ram:LineOne>` : ''}
      ${addr.address[1] ? `<ram:LineTwo>${escape(addr.address[1])}</ram:LineTwo>` : ''}
      ${addr.address[2] ? `<ram:LineThree>${escape(addr.address[2])}</ram:LineThree>` : ''}
      ${addr.postCode ? `<ram:PostcodeCode>${escape(addr.postCode)}</ram:PostcodeCode>` : ''}
      ${addr.city ? `<ram:CityName>${escape(addr.city)}</ram:CityName>` : ''}
      <ram:CountryID>${escape(addr.countryCode)}</ram:CountryID>
      ${addr.countrySubdivision ? `<ram:CountrySubDivisionName>${escape(addr.countrySubdivision)}</ram:CountrySubDivisionName>` : ''}`;

  const taxRegs = (regs: TaxRegistration[]) =>
    regs
      .map(
        (r) =>
          `<ram:SpecifiedTaxRegistration><ram:ID schemeID="${escape(r.type)}">${escape(r.value)}</ram:ID></ram:SpecifiedTaxRegistration>`,
      )
      .join('');

  const sellerXml = `<ram:SellerTradeParty>
      ${data.seller.sellerId ? `<ram:ID>${escape(data.seller.sellerId)}</ram:ID>` : ''}
      <ram:Name>${escape(data.seller.sellerName)}</ram:Name>
      <ram:PostalTradeAddress>${postal(data.seller.postalAddress)}</ram:PostalTradeAddress>
      ${taxRegs(data.seller.taxRegistrations)}
    </ram:SellerTradeParty>`;

  const buyerXml = `<ram:BuyerTradeParty>
      ${data.buyer.buyerId ? `<ram:ID>${escape(data.buyer.buyerId)}</ram:ID>` : ''}
      <ram:Name>${escape(data.buyer.buyerName)}</ram:Name>
      <ram:PostalTradeAddress>${postal(data.buyer.postalAddress)}</ram:PostalTradeAddress>
      ${taxRegs(data.buyer.taxRegistrations)}
    </ram:BuyerTradeParty>`;

  const lineItems = (data.transaction.positions || [])
    .map(
      (p) => `<ram:IncludedSupplyChainTradeLineItem>
        <ram:AssociatedDocumentLineDocument>
          <ram:LineID>${escape(p.lineId)}</ram:LineID>
        </ram:AssociatedDocumentLineDocument>
        <ram:SpecifiedTradeProduct>
          ${p.gtin ? `<ram:GlobalID>${escape(p.gtin)}</ram:GlobalID>` : ''}
          <ram:Name>${escape(p.name)}</ram:Name>
          ${p.description ? `<ram:Description>${escape(p.description)}</ram:Description>` : ''}
        </ram:SpecifiedTradeProduct>
        <ram:SpecifiedLineTradeDelivery>
          <ram:BilledQuantity unitCode="${escape(p.unitCode)}">${fmt(p.quantity)}</ram:BilledQuantity>
        </ram:SpecifiedLineTradeDelivery>
        <ram:SpecifiedLineTradeAgreement>
          <ram:NetPriceProductTradePrice>
            <ram:ChargeAmount>${fmt(p.netItemPrice)}</ram:ChargeAmount>
          </ram:NetPriceProductTradePrice>
          <ram:GrossPriceProductTradePrice>
            <ram:ChargeAmount>${fmt(p.grossItemPrice)}</ram:ChargeAmount>
          </ram:GrossPriceProductTradePrice>
        </ram:SpecifiedLineTradeAgreement>
        <ram:SpecifiedLineTradeSettlement>
          <ram:SpecifiedTradeSettlementLineMonetarySummation>
            <ram:LineTotalAmount>${fmt(p.total)}</ram:LineTotalAmount>
          </ram:SpecifiedTradeSettlementLineMonetarySummation>
        </ram:SpecifiedLineTradeSettlement>
      </ram:IncludedSupplyChainTradeLineItem>`,
    )
    .join('');

  const taxes = (data.transaction.taxes || [])
    .map(
      (t) => `<ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${fmt(t.taxAmount)}</ram:CalculatedAmount>
        <ram:TypeCode>${escape(t.taxType)}</ram:TypeCode>
        <ram:BasisAmount>${fmt(t.totalNet)}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>${escape(t.taxPercent)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`,
    )
    .join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:factur-x:pdfa:CrossIndustryInvoice:invoice:1p0" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>${escape(data.meta.businessProcessType)}</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${escape(data.meta.specificationProfile)}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${escape(data.documentId)}</ram:ID>
    <ram:TypeCode>${escape(data.documentType)}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${escape(data.documentDate)}</udt:DateTimeString>
    </ram:IssueDateTime>
    ${noteXml}
    ${data.buyerReference ? `<ram:BuyerReference>${escape(data.buyerReference)}</ram:BuyerReference>` : ''}
    ${data.leitwegId ? `<ram:BuyerAssignedAccountID>${escape(data.leitwegId)}</ram:BuyerAssignedAccountID>` : ''}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      ${sellerXml}
      ${buyerXml}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${escape(data.transaction.currency)}</ram:InvoiceCurrencyCode>
      ${taxes}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${fmt(data.transaction.totalNet)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${fmt(data.transaction.totalNet)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount>${fmt(data.transaction.totalVat)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${fmt(data.transaction.totalGross)}</ram:GrandTotalAmount>
        <ram:TotalPrepaidAmount>${fmt(data.transaction.totalPrepaid)}</ram:TotalPrepaidAmount>
        <ram:DuePayableAmount>${fmt(data.transaction.totalPayable)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
    ${lineItems}
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

  return xml;
}

export async function attachXmlToPDF(
  this: IExecuteFunctions,
  binaryPropertyName: string,
  xml: string,
  xmlFilename: string,
  itemIndex = 0,
) {
  const binaryData = this.helpers.assertBinaryData(itemIndex, binaryPropertyName);

  let buffer: Buffer;
  if (binaryData.id) {
    buffer = await this.helpers.binaryToBuffer(await this.helpers.getBinaryStream(binaryData.id));
  } else {
    buffer = Buffer.from(binaryData.data, BINARY_ENCODING);
  }

  const pdfDoc = await PDFDocument.load(buffer);
  pdfDoc.attach(xml, xmlFilename, { mimeType: 'application/xml' });
  const pdfBytes = await pdfDoc.save();

  return this.helpers.prepareBinaryData(Buffer.from(pdfBytes), binaryData.fileName || 'document.pdf', 'application/pdf');
}

export async function createPdfStub(xml: string, xmlFilename: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage();
  pdfDoc.attach(xml, xmlFilename, { mimeType: 'application/xml' });
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/*
 * Parses XML invoice data into a JSON object.
 * Takes XML string input and returns either raw JSON or simplified format.
 * Validates profile identifier and maps it to standard profile names.
 * Throws error if XML is invalid or missing required data.
 */
async function parseEInvoiceXML(xml: string, mode: 'json' | 'simple') {
    const parserOptions = {
        mergeAttrs: true,
        explicitArray: false,
        tagNameProcessors: [
            (name: string) => name.replace(/^.*:/, '')
        ],
        attrNameProcessors: [
            (name: string) => name.replace(/^.*:/, '')
        ],
        ignoreAttrs: true // Remove xmlns attributes
    };

    const parser = new Parser(parserOptions);
    const json = await parser.parseStringPromise(xml);

    // if we really just want the json, we can return it now
    if(mode === 'json') {
        return json;
    }
    // otherwise we simplify the response
    if(!json.CrossIndustryInvoice){
        throw new Error("no CrossIndustryInvoice after parsing found in xml");
    }

    const profileId = json.CrossIndustryInvoice?.ExchangedDocumentContext?.GuidelineSpecifiedDocumentContextParameter?.ID;
    if (!profileId) {
        throw new Error("missing profile identifier");
    }
    const profile = resolveProfileId(profileId);

  // otherwise we simplify the response
  const simplified = {} as EInvoice;
  const ci = json.CrossIndustryInvoice;

  // Meta data
  simplified.meta = {
      specificationProfile: profile,
      businessProcessType: ci.ExchangedDocumentContext?.BusinessProcessSpecifiedDocumentContext?.ID || 'A1'
  };

  // Document info
  simplified.documentId = ci.ExchangedDocument?.ID;
  simplified.documentType = ci.ExchangedDocument?.TypeCode;
  simplified.documentDate = ci.ExchangedDocument?.IssueDateTime?.DateTimeString;
  simplified.notes = ci.ExchangedDocument?.IncludedNote ? [{
      text: ci.ExchangedDocument.IncludedNote.Content,
      code: ci.ExchangedDocument.IncludedNote.SubjectCode
  }] : [];
  simplified.buyerReference = ci.ExchangedDocument?.BuyerReference || null;
  simplified.leitwegId = ci.ExchangedDocument?.BuyerAssignedAccountID || null;

  // Trade parties
  const agreement = ci.SupplyChainTradeTransaction?.ApplicableHeaderTradeAgreement;

  // Seller
  const sellerParty = agreement?.SellerTradeParty;
  if (sellerParty) {
      simplified.seller = {
          sellerId: sellerParty.ID,
          sellerName: sellerParty.Name,
          postalAddress: {
              address: [
                  sellerParty.PostalTradeAddress?.LineOne,
                  sellerParty.PostalTradeAddress?.LineTwo,
                  sellerParty.PostalTradeAddress?.LineThree
              ],
              postCode: sellerParty.PostalTradeAddress?.PostcodeCode,
              city: sellerParty.PostalTradeAddress?.CityName,
              countryCode: sellerParty.PostalTradeAddress?.CountryID,
              countrySubdivision: sellerParty.PostalTradeAddress?.CountrySubDivisionName
          },
          taxRegistrations: sellerParty.SpecifiedTaxRegistration ? [{
              type: sellerParty.SpecifiedTaxRegistration.ID?.schemeID,
              value: sellerParty.SpecifiedTaxRegistration.ID
          }] : []
      };
  }

  // Buyer
  const buyerParty = agreement?.BuyerTradeParty;
  if (buyerParty) {
      simplified.buyer = {
          buyerId: buyerParty.ID,
          buyerName: buyerParty.Name,
          postalAddress: {
              address: [
                  buyerParty.PostalTradeAddress?.LineOne,
                  buyerParty.PostalTradeAddress?.LineTwo,
                  buyerParty.PostalTradeAddress?.LineThree
              ],
              postCode: buyerParty.PostalTradeAddress?.PostcodeCode,
              city: buyerParty.PostalTradeAddress?.CityName,
              countryCode: buyerParty.PostalTradeAddress?.CountryID,
              countrySubdivision: buyerParty.PostalTradeAddress?.CountrySubDivisionName
          },
          taxRegistrations: buyerParty.SpecifiedTaxRegistration ? [{
              type: buyerParty.SpecifiedTaxRegistration.ID?.schemeID,
              value: buyerParty.SpecifiedTaxRegistration.ID
          }] : []
      };
  }

  // Transaction details
  const settlement = ci.SupplyChainTradeTransaction?.ApplicableHeaderTradeSettlement;
  simplified.transaction = {
      currency: settlement?.InvoiceCurrencyCode,
      totalGross: parseFloat(settlement?.SpecifiedTradeSettlementHeaderMonetarySummation?.GrandTotalAmount || '0'),
      totalNet: parseFloat(settlement?.SpecifiedTradeSettlementHeaderMonetarySummation?.LineTotalAmount || '0'),
      totalVat: parseFloat(settlement?.SpecifiedTradeSettlementHeaderMonetarySummation?.TaxTotalAmount || '0'),
      totalPrepaid: parseFloat(settlement?.SpecifiedTradeSettlementHeaderMonetarySummation?.TotalPrepaidAmount || '0'),
      totalPayable: parseFloat(settlement?.SpecifiedTradeSettlementHeaderMonetarySummation?.DuePayableAmount || '0'),
      paymentReference: settlement?.PaymentReference || '',
      taxes: settlement?.ApplicableTradeTax?.map( (tax: any) => ({
          taxType: 'VAT',
          taxPercent: parseFloat(tax.RateApplicablePercent || '0'),
          taxAmount: parseFloat(tax.CalculatedAmount || '0'),
          totalNet: parseFloat(tax.BasisAmount || '0')
      })) || [],
      positions: ci.SupplyChainTradeTransaction?.IncludedSupplyChainTradeLineItem?.map((item: any) => ({
          lineId: item.AssociatedDocumentLineDocument?.LineID,
          gtin: item.SpecifiedTradeProduct?.GlobalID,
          name: item.SpecifiedTradeProduct?.Name,
          quantity: parseFloat(item.SpecifiedLineTradeDelivery?.BilledQuantity || '0'),
          netItemPrice: parseFloat(item.SpecifiedLineTradeAgreement?.NetPriceProductTradePrice?.ChargeAmount || '0'),
          total: parseFloat(item.SpecifiedLineTradeSettlement?.SpecifiedTradeSettlementLineMonetarySummation?.LineTotalAmount || '0')
      })) || []
  };

      // Sanity Checks
      if (!Object.values<string>(DOCUMENT_TYPES).includes(simplified.documentType)) {
        throw new Error("XML contains invalid Invoice type code: " + simplified.documentType);
      }

      // make document code more readable
      simplified.documentTypeCode = DOCUMENT_TYPES[simplified.documentType as keyof typeof DOCUMENT_TYPES];

      if (!simplified.seller) {
        throw new Error("XML is missing Seller Entity");
      }
      if (!simplified.buyer) {
        throw new Error("XML is missing Buyer Entity");
      }

  return simplified;
}