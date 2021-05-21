// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  TeamsActivityHandler,
  ActionTypes,
  CardFactory,
  TurnContext,
  ActivityTypes,
  Attachment,
  Activity,
  MessageFactory,
  ConversationResourceResponse,
  ConversationParameters,
  ConversationReference,
  TeamsChannelData,
  ChannelInfo,
  BotFrameworkAdapter,
} from "botbuilder";
import {
  QnADTO,
  QnASearchResultList,
} from "@azure/cognitiveservices-qnamaker-runtime/esm/models";
import { ResponseCardPayload } from "./models/responseCardPayload";
import { AnswerModel } from "./models/answerModel";
import { QnaServiceProvider } from "./providers/qnaServiceProvider";
import { getResponseCard } from "./cards/responseCard";
import { getAskAnExpertCard } from "./cards/askAnExpertCard";
import { TicketEntity } from "./models/ticketEntity";
import { Constants } from "./common/constants";
import { getUnrecognizedInputCard } from "./cards/unrecognizedInputCard";
import { AskAnExpertCardPayload } from "./models/askAnExpertCardPayload";
import { TicketsProvider } from "./providers/ticketsProvider";
import { askAnExpertSubmitText } from "./common/adaptiveHelper";
import { getSmeTicketCard } from "./cards/smeTicketCard";
import { ConfigurationDataProvider } from "./providers/configurationProvider";
import { ConfigurationEntityTypes } from "./models/configurationEntityTypes";

export class TeamsBot extends TeamsActivityHandler {
  private readonly conversationTypePersonal: string = "personal";
  private readonly qnaServiceProvider: QnaServiceProvider;
  private readonly ticketsProvider: TicketsProvider;
  private readonly configurationProvider: ConfigurationDataProvider;

  /**
   *
   * @param {QnaServiceProvider} qnaServiceProvider
   */
  constructor(
    configurationProvider: ConfigurationDataProvider,
    qnaServiceProvider: QnaServiceProvider,
    ticketsProvider: TicketsProvider
  ) {
    super();

    this.qnaServiceProvider = qnaServiceProvider;
    this.ticketsProvider = ticketsProvider;
    this.configurationProvider = configurationProvider;

    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (let cnt = 0; cnt < membersAdded.length; cnt++) {
        if (membersAdded[cnt].id) {
          const cardButtons = [
            {
              type: ActionTypes.ImBack,
              title: "Show introduction card",
              value: "intro",
            },
          ];
          const card = CardFactory.heroCard("Welcome", null, cardButtons, {
            text: `Congratulations! Your hello world Bot 
                            template is running. This bot will introduce you how to build bot using Microsoft Teams App Framework(TeamsFx). 
                            You can reply <strong>intro</strong> to see the introduction card. TeamsFx helps you build Bot using <a href=\"https://dev.botframework.com/\">Bot Framework SDK</a>`,
          });
          await context.sendActivity({ attachments: [card] });
          break;
        }
      }
      await next();
    });
  }

  async onMessageActivity(turnContext: TurnContext): Promise<void> {
    try {
      const message = turnContext.activity;
      console.log(
        `from: ${message.from?.id}, conversation: ${message.conversation.id}, replyToId: ${message.replyToId}`
      );
      await this.sendTypingIndicatorAsync(turnContext);

      switch (message.conversation.conversationType.toLowerCase()) {
        case this.conversationTypePersonal:
          await this.onMessageActivityInPersonalChat(message, turnContext);
          break;
        default:
          console.log(
            `Received unexpected conversationType ${message.conversation.conversationType}`
          );
          break;
      }
    } catch (error) {
      await turnContext.sendActivity("");
      console.log(`Error processing message: ${error.message}`);
      throw error;
    }
  }

  private async onMessageActivityInPersonalChat(
    message: Activity,
    turnContext: TurnContext
  ): Promise<void> {
    if (message.replyToId && message.value != null) {
      console.log("Card submit in 1:1 chat");
      await this.OnAdaptiveCardSubmitInPersonalChatAsync(message, turnContext);
      return;
    }

    const text = message.text?.toLowerCase()?.trim() ?? "";

    switch (text) {
      case Constants.AskAnExpert:
        console.log("Sending user ask an expert card");
        await turnContext.sendActivity(
          MessageFactory.attachment(getAskAnExpertCard())
        );
        break;

      default:
        console.log("Sending input to QnAMaker");
        await this.getQuestionAnswerReply(turnContext, message);
    }
  }

  private async OnAdaptiveCardSubmitInPersonalChatAsync(
    message: Activity,
    turnContext: TurnContext
  ): Promise<void> {
    let smeTeamCard: Attachment; // Notification to SME team
    let userCard: Attachment; // Acknowledgement to the user
    let newTicket: TicketEntity; // New ticket

    switch (message?.text) {
      case Constants.AskAnExpert:
        console.log("Sending user ask an expert card (from answer)");
        let askAnExpertCardPayload: AskAnExpertCardPayload = message.value as AskAnExpertCardPayload;
        await turnContext.sendActivity(
          MessageFactory.attachment(getAskAnExpertCard(askAnExpertCardPayload))
        );
        break;

      case Constants.AskAnExpertSubmitText:
        console.log("Received question for expert");
        newTicket = await askAnExpertSubmitText(
          message,
          turnContext,
          this.ticketsProvider
        );
        if (newTicket) {
          smeTeamCard = getSmeTicketCard(newTicket, message.localTimestamp);
          userCard = getSmeTicketCard(newTicket, message.localTimestamp);
        }
        break;

      default:
        let payload = message.value as ResponseCardPayload;
        if (payload.IsPrompt) {
          console.log("Sending input to QnAMaker for prompt");
          await this.getQuestionAnswerReply(turnContext, message);
        } else {
          console.log("Unexpected text in submit payload: " + message.text);
        }
    }

    // Send message to SME team.
    const expertTeamId: string = await this.configurationProvider.getSavedEntityDetailAsync(
      ConfigurationEntityTypes.TeamId
    );

    if (smeTeamCard) {
      let resourceResponse = await this.sendCardToTeamAsync(
        turnContext,
        smeTeamCard,
        expertTeamId
      );

      // If a ticket was created, update the ticket with the conversation info.
      if (newTicket) {
        newTicket.SmeCardActivityId = resourceResponse?.activityId;
        newTicket.SmeThreadConversationId = resourceResponse.id;
        await this.ticketsProvider.upsertTicket(newTicket);
      }
    }

    // Send acknowledgment to the user
    if (userCard) {
      await turnContext.sendActivity(MessageFactory.attachment(userCard));
    }
  }

  private async sendCardToTeamAsync(
    turnContext: TurnContext,
    cardToSend: Attachment,
    teamId: string
  ): Promise<ConversationResourceResponse> {
    const conversationParameter = {
      activity: MessageFactory.attachment(cardToSend) as Activity,
      channelData: {
        channel: teamId as ChannelInfo,
      } as TeamsChannelData,
    } as ConversationParameters;

    const conversationReference = {
      channelId: null, // If we set channel = "msteams", there is an error as preinstalled middleware expects ChannelData to be present.
      serviceUrl: turnContext.activity.serviceUrl,
    } as ConversationReference;

    return new Promise<ConversationResourceResponse>(async (resolve) => {
      try {
        await (turnContext.adapter as BotFrameworkAdapter)
          .createConversation(
            conversationReference,
            conversationParameter,
            (turnContext) => {
              let activity = turnContext.activity;
              const conversationResourceResponse: ConversationResourceResponse = {
                id: activity.conversation.id,
                activityId: activity.id,
                serviceUrl: activity.serviceUrl,
              };
              resolve(conversationResourceResponse);
              return Promise.resolve();
            }
          )
          .catch((e) => {
            console.log("[debug]err: " + e);
          });
      } catch (e) {
        console.log("[debug] e: " + e);
      }
    });
  }

  private async getQuestionAnswerReply(
    turnContext: TurnContext,
    message: Activity
  ): Promise<void> {
    const text = message.text?.toLowerCase()?.trim() ?? "";

    try {
      let queryResult: QnASearchResultList;
      let payload: ResponseCardPayload;

      if (message?.replyToId && message?.value) {
        payload = message.value as ResponseCardPayload;
      }

      let previousQuestion: QnADTO;
      if (payload?.PreviousQuestions?.length > 0) {
        previousQuestion = payload.PreviousQuestions[0];
      }

      queryResult = await this.qnaServiceProvider.gGenerateAnswer(
        text,
        false,
        previousQuestion?.id.toString(),
        previousQuestion?.questions[0]
      );

      if (queryResult?.answers[0].id != -1) {
        const answerData = queryResult.answers[0];
        let answerModel: AnswerModel;
        try {
          answerModel = JSON.parse(answerData.answer) as AnswerModel;
        } catch {
          // do nothing if result is not json format
        }

        await turnContext.sendActivity(
          MessageFactory.attachment(getResponseCard(answerData, text, payload))
        );
      } else {
        console.log("Answer not found. Sending user ask an expert card");
        await turnContext.sendActivity(
          MessageFactory.attachment(getUnrecognizedInputCard(text))
        );
      }
    } catch (error) {
      console.log(error);
    }
  }

  private async sendTypingIndicatorAsync(
    turnContext: TurnContext
  ): Promise<void> {
    try {
      const typingActivity = this.createReply(turnContext.activity);
      typingActivity.type = ActivityTypes.Typing;
      await turnContext.sendActivity(typingActivity);
    } catch (error) {
      console.log(`Failed to send a typing indicator: ${error.message}`);
    }
  }

  private createReply(
    source: Activity,
    text?: string,
    locale?: string
  ): Activity {
    const reply: string = text || "";

    return {
      channelId: source.channelId,
      conversation: source.conversation,
      from: source.recipient,
      label: source.label,
      locale: locale,
      callerId: source.callerId,
      recipient: source.from,
      replyToId: source.id,
      serviceUrl: source.serviceUrl,
      text: reply,
      timestamp: new Date(),
      type: ActivityTypes.Message,
      valueType: source.valueType,
      localTimezone: source.localTimezone,
      listenFor: source.listenFor,
      semanticAction: source.semanticAction,
    };
  }
}