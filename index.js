const fs = require('fs');
const { formatEther } = require('ethers')

/*
query MyQuery {
  operators(where: {contractVersion: "1"}, first: 1000, block: {number: 54335428}) {
    id
    delegations {
      delegator {
        id
      }
      operatorTokenBalanceWei
    }
    owner
    metadataJsonString
    operatorTokenTotalSupplyWei
    valueWithoutEarnings
  }
}
*/

let rawdata = fs.readFileSync('data.json');
let data = JSON.parse(rawdata);

console.log('OperatorId,OperatorName,Owner,TotalOperatorTokens,DelegatorId,DelegatorsOperatorTokens')

data.data.operators.forEach(operator => {
    const name = JSON.parse(operator.metadataJsonString).name
    const valueWithoutEarnings = formatEther(operator.valueWithoutEarnings)
    const operatorTokenTotalSupply = formatEther(operator.operatorTokenTotalSupplyWei)
    operator.delegations.forEach(delegation => {
        const delegatorsOperatorTokens = formatEther(delegation.operatorTokenBalanceWei)
        console.log(`${operator.id},${name},${operator.owner},${operatorTokenTotalSupply},${delegation.delegator.id},${delegatorsOperatorTokens}`)
    })  
})
