import gql from "graphql-tag";
import { ApolloClient } from 'apollo-client';
import { createHttpLink } from 'apollo-link-http'
import { InMemoryCache } from 'apollo-cache-inmemory'
import BigNumber from "bignumber.js";
import fetch from 'cross-fetch';
import { formatEther } from "ethers";

const BLOCKS_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/matthewlilley/polygon-blocks'
const STREAMR_SUBGRAPH_URL = 'https://gateway-arbitrum.network.thegraph.com/api/8bcbd55cdd1369cadb0bb813d9817776/subgraphs/id/EGWFdhhiWypDuz22Uy7b3F69E9MEkyfU9iAQMttkH5Rj'

const START_TIME = 1709733209
const END_TIME = Math.floor(new Date().getTime()/1000)
const MIN_SLASHING_WEI = '0'

const PAGE_SIZE = 1000

  const blocksHttpLink = createHttpLink({
    uri: BLOCKS_SUBGRAPH_URL,
    fetch,
  });

  const streamrHttpLink = createHttpLink({
    uri: STREAMR_SUBGRAPH_URL,
    fetch,
  });
  
  const blocksClient = new ApolloClient({
    link: blocksHttpLink,
    cache: new InMemoryCache(),
  });

const streamrClient = new ApolloClient({
    link: streamrHttpLink,
    cache: new InMemoryCache()
})

async function getBlockAtTimestamp(timestampSec: number): Promise<number> {
    const query = gql`
      {
        blocks(
          where: {timestamp: "${timestampSec}"}
        ) {
          id
          number
          timestamp
        }
      }
    `
    const { data } = await blocksClient.query({ query })
    if (data.blocks.length !== 1) {
        throw new Error(`Unexpected blocks: ${data.blocks.length}: ${JSON.stringify(data)}`)
    }

    return data.blocks[0].number
}

type OperatorAndDelegations = {
    operatorTokenTotalSupplyWei: string,
    exchangeRate: string,
    owner: string,
    valueWithoutEarnings: string,
    delegations: {
        delegator: {
            id: string
        }
        operatorTokenBalanceWei: string
    }[],
}

async function getOperatorAndDelegationsAtBlock(operatorAddress: string, block: number): Promise<OperatorAndDelegations> {
    const query = gql`
    {
        operator(
          id: "${operatorAddress.toLowerCase()}"
          block: {number: ${block}}
        ) {
          delegations {
            delegator {
              id
            }
            operatorTokenBalanceWei
          }
          exchangeRate
          operatorTokenTotalSupplyWei
          owner
          valueWithoutEarnings
        }
    }`

    const { data } = await streamrClient.query({ query })
    if (!data.operator) {
        throw new Error(`Operator not found: ${operatorAddress} at block ${block}`)
    }

    return data.operator as OperatorAndDelegations
}

type SlashingEvent = {
    amount: string,
    date: string,
    operator: {
        id: string,
    }
}

async function getSlashingEvents(timestampStartSec: number, timestampEndSec: number): Promise<SlashingEvent[]> {
    let result: SlashingEvent[] = []
    let currentStart = timestampStartSec
    while (true) {
        const pageResults = await getSlashingEventsPage(currentStart, timestampEndSec)
        result = [...result, ...pageResults]
        if (pageResults.length < PAGE_SIZE) {
            break
        } else {
            // Next page start time must be minimally greater than the timestamp of the last result of this page
            currentStart = parseInt(pageResults[pageResults.length - 1].date) + 1
        }
    }

    // Filter out events below the minimum
    const min = new BigNumber(MIN_SLASHING_WEI)
    return result.filter(slashingEvent => new BigNumber(slashingEvent.amount).gte(min))
}

async function getSlashingEventsPage(timestampStartSec: number, timestampEndSec: number): Promise<SlashingEvent[]> {
    const query = gql`
    {
        slashingEvents(
            orderBy: date
            orderDirection: asc
            first: ${PAGE_SIZE}
            where: {date_gte: "${timestampStartSec}", date_lte: "${timestampEndSec}"}
        ) {
            amount
            date
            operator {
            id
            }
        }
    }`

    const { data } = await streamrClient.query({ query })
    return data.slashingEvents as SlashingEvent[]
}

type Reimbursement = {
    recipient: string
    amount: BigNumber
}

async function calculateReimbursements(slashingEvent: SlashingEvent): Promise<Reimbursement[]> {
    const blockNumber = await getBlockAtTimestamp(parseInt(slashingEvent.date))
    const operator = await getOperatorAndDelegationsAtBlock(slashingEvent.operator.id, blockNumber-1)
    const slashedAmountDataWei = new BigNumber(slashingEvent.amount)
    const totalOperatorTokensWei = new BigNumber(operator.operatorTokenTotalSupplyWei)
    const valueWithoutEarningsWei = new BigNumber(operator.valueWithoutEarnings)
    const exchangeRate = valueWithoutEarningsWei.div(totalOperatorTokensWei)
    const slashedAmountInOperatorTokensWei = slashedAmountDataWei.dividedBy(exchangeRate).dividedToIntegerBy(1)

    if (!operator.delegations.length) {
        throw new Error(`Operator doesn't have delegations: ${slashingEvent.operator.id}, block ${blockNumber}: ${JSON.stringify(operator)}`)
    }

    const ownerDelegation = operator.delegations.find(delegation => delegation.delegator.id === operator.owner)
    if (!ownerDelegation) {
        throw new Error(`Owner's delegation not found: ${JSON.stringify(operator)}`)
    }
    const ownerOperatorTokensWei = new BigNumber(ownerDelegation.operatorTokenBalanceWei)
    
    const reimbursements: Reimbursement[] = []

    // Does the owner fully absorb the hit?
    if (ownerOperatorTokensWei.gte(slashedAmountInOperatorTokensWei)) {
        // If yes, the Operator will take the whole hit
        reimbursements.push({
            recipient: operator.owner,
            amount: slashedAmountDataWei,
        })
    } else {
        // Operator takes part of the hit and the delegators take the rest
        const ownerSlashedAmountDataWei = ownerOperatorTokensWei.multipliedBy(exchangeRate).dividedToIntegerBy(1)
        reimbursements.push({
            recipient: operator.owner,
            amount: ownerSlashedAmountDataWei,
        })

        // How much value remains to be slashed?
        const slashingRemainingDataWei = slashedAmountDataWei.minus(ownerSlashedAmountDataWei)
        const operatorTokensRemainingAfterOwnerSlashedWei = totalOperatorTokensWei.minus(ownerOperatorTokensWei)

        // Divide the remaining amount across the remaining delegators
        for (const delegation of operator.delegations.filter(delegation => delegation.delegator.id !== operator.owner)) {
            const operatorTokensHeldByDelegator = new BigNumber(delegation.operatorTokenBalanceWei)
            const share = operatorTokensHeldByDelegator.div(operatorTokensRemainingAfterOwnerSlashedWei)
            const shareDataWei = share.multipliedBy(slashingRemainingDataWei).dividedToIntegerBy(1)
            reimbursements.push({
                recipient: delegation.delegator.id,
                amount: shareDataWei,
            })
        }
    }

    // Sanity check: the sum of reimbursements can't exceed the slashed amount
    let reimbursementsTotal = new BigNumber(0)
    reimbursements.forEach(reimbursement => reimbursementsTotal = reimbursementsTotal.plus(reimbursement.amount))

    // Add some tolerance for rounding errors
    if (reimbursementsTotal.minus(slashedAmountDataWei).abs().gt(new BigNumber('10000'))) {
        console.error(`Reimbursements: ${formatEther(reimbursementsTotal.toFixed(0))}`)
        console.error(`Slashed amount: ${formatEther(slashedAmountDataWei.toFixed(0))}`)
        console.error(reimbursements)
        throw new Error(`Reimbursements don't match slashed amount`)
    }

    return reimbursements.sort((a, b) => a.recipient.localeCompare(b.recipient));
}

;(async () => {
    const slashingEvents = await getSlashingEvents(START_TIME, END_TIME)
    for (const slashingEvent of slashingEvents) {
        const reimbursements = await calculateReimbursements(slashingEvent)
        for (const reimbursement of reimbursements) {
            console.log(`${reimbursement.recipient},${reimbursement.amount.toFixed(0)}`)
        }
    }
})()