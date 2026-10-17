@description('Resource ID of the Application Insights component the workbook queries.')
param applicationInsightsResourceId string = '/subscriptions/598dbc31-fcbe-4cb1-a3d6-16d49d33a5cb/resourceGroups/Quartz/providers/microsoft.insights/components/appi-quartz-prod'

@description('Azure region used to store the workbook resource.')
param location string = resourceGroup().location

@description('Display name shown in Azure Monitor Workbooks.')
param workbookDisplayName string = 'Quartz telemetry overview'

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: guid(applicationInsightsResourceId, 'quartz-telemetry-overview')
  location: location
  kind: 'shared'
  properties: {
    category: 'workbook'
    displayName: workbookDisplayName
    serializedData: loadTextContent('workbooks/quartz-telemetry-overview.workbook.json')
    sourceId: applicationInsightsResourceId
    version: '1.0'
  }
}

output workbookId string = workbook.id
output workbookName string = workbook.name
